import sys
import os
import json
import re
import time
from hashlib import sha256
from openai import OpenAI
from dotenv import load_dotenv

# Load environment variables (uses Render's env vars if no .env file)
load_dotenv()
api_key = os.getenv("OPENAI_API_KEY")
if not api_key:
    print("Error: OPENAI_API_KEY not set in environment", file=sys.stderr)
    sys.exit(1)

# Flush stderr to ensure errors are captured
sys.stderr.flush()

def clean_json_response(content):
    """Remove Markdown code fences and leading/trailing text from JSON response."""
    content = re.sub(r'^```json\s*|\s*```$', '', content, flags=re.MULTILINE)
    content = content.strip()
    if not content.startswith('[') or not content.endswith(']'):
        raise ValueError("Response does not contain valid JSON array")
    return content

class QuestionGenerator:
    def __init__(self):
        try:
            self.client = OpenAI(api_key=api_key)
        except Exception as e:
            print(f"Error initializing OpenAI client: {str(e)}", file=sys.stderr)
            sys.exit(1)

    def generate_questions(self, tweets, num_questions=15, max_retries=3):
        tweet_text = "\n".join([f"{t['created_at']}: {t['text']}" for t in tweets])
        prompt = f"""
Your task is to generate EXACTLY {num_questions} trivia questions with 4 multiple-choice answers each based on the following tweets.

IMPORTANT: You MUST generate EXACTLY {num_questions} questions - no more, no less. This is critical.

The questions must be based on tweet content (events, mentions, interests, etc.) and should be engaging for someone familiar with the user's public activity. If the tweets don't provide enough direct content, create plausible questions related to the topics mentioned.

Return a JSON array of EXACTLY {num_questions} objects, each with:
- 'question': The trivia question
- 'options': Array of 4 strings representing possible answers
- 'correct_answer': Index of the correct answer (0-3)
- 'hash': SHA256 of question + correct answer (leave this blank, it will be added later)

Output only the JSON array, without Markdown code fences or extra text.

Tweets:
{tweet_text}

Example of expected format:
[
    {{
        "question": "Which event did the user tweet about in April?",
        "options": ["Conference", "Birthday", "Concert", "Meeting"],
        "correct_answer": 0,
        "hash": ""
    }},
    {{
        "question": "What technology was the user exploring for their next project?",
        "options": ["Blockchain", "Neural networks", "Quantum computing", "Augmented reality"],
        "correct_answer": 1,
        "hash": ""
    }},
    ...and so on until EXACTLY {num_questions} questions
]

Remember: I need EXACTLY {num_questions} questions. Create additional relevant questions if needed to reach this count.
"""
        for attempt in range(max_retries):
            try:
                response = self.client.chat.completions.create(
                    model="gpt-4o-mini",
                    messages=[{"role": "user", "content": prompt}],
                    max_tokens=3000,
                    temperature=0.7
                )
                content = response.choices[0].message.content.strip()
                try:
                    cleaned_content = clean_json_response(content)
                    questions = json.loads(cleaned_content)
                except (ValueError, json.JSONDecodeError) as e:
                    print(f"Invalid JSON response on attempt {attempt + 1}: {str(e)}", file=sys.stderr)
                    print(f"Raw content: {content[:200]}...", file=sys.stderr)
                    if attempt == max_retries - 1:
                        raise ValueError(f"Failed to parse JSON after {max_retries} attempts: {str(e)}")
                    time.sleep(2)
                    continue

                if not isinstance(questions, list):
                    print(f"Error on attempt {attempt + 1}: Expected list, got {type(questions)}", file=sys.stderr)
                    if attempt == max_retries - 1:
                        raise ValueError("Response is not a list")
                    time.sleep(2)
                    continue

                if len(questions) < num_questions:
                    print(f"Warning: Only got {len(questions)} questions, expected {num_questions}", file=sys.stderr)
                    if num_questions - len(questions) <= 2 and attempt < max_retries - 1:
                        missing = num_questions - len(questions)
                        print(f"Generating {missing} additional questions...", file=sys.stderr)
                        additional_prompt = f"""
Based on these tweets, generate exactly {missing} more trivia questions with 4 multiple-choice answers each.
Make them different from these existing questions:
{json.dumps(questions, indent=2)}

Tweets:
{tweet_text}

Return ONLY a JSON array with exactly {missing} question objects.
"""
                        additional_response = self.client.chat.completions.create(
                            model="gpt-4o-mini",
                            messages=[{"role": "user", "content": additional_prompt}],
                            max_tokens=1000
                        )
                        additional_content = additional_response.choices[0].message.content.strip()
                        try:
                            additional_content = clean_json_response(additional_content)
                            additional_questions = json.loads(additional_content)
                            questions.extend(additional_questions)
                            print(f"Successfully added {len(additional_questions)} questions", file=sys.stderr)
                        except Exception as e:
                            print(f"Failed to add additional questions: {e}", file=sys.stderr)

                    if len(questions) < num_questions and attempt == max_retries - 1:
                        missing = num_questions - len(questions)
                        print(f"Generating {missing} synthetic questions...", file=sys.stderr)
                        topics = ["AI", "Blockchain", "Crypto", "NFTs", "Technology", "Fitness", "Travel"]
                        for i in range(missing):
                            topic = topics[i % len(topics)]
                            questions.append({
                                "question": f"Based on the tweets, which {topic}-related activity might the user be interested in?",
                                "options": [
                                    f"{topic} conference",
                                    f"{topic} development",
                                    f"{topic} investment",
                                    f"{topic} community"
                                ],
                                "correct_answer": i % 4,
                                "hash": ""
                            })

                if len(questions) > num_questions:
                    print(f"Trimming from {len(questions)} to {num_questions} questions", file=sys.stderr)
                    questions = questions[:num_questions]

                invalid_questions = [
                    i for i, q in enumerate(questions)
                    if not (isinstance(q, dict) and
                           "question" in q and
                           "options" in q and len(q["options"]) == 4 and
                           "correct_answer" in q and 0 <= q["correct_answer"] <= 3)
                ]
                if invalid_questions:
                    print(f"Error on attempt {attempt + 1}: Invalid format in questions {invalid_questions}", file=sys.stderr)
                    if attempt == max_retries - 1:
                        for i in invalid_questions:
                            if i < len(questions):
                                q = questions[i]
                                if "question" not in q:
                                    q["question"] = f"What topic was mentioned in the user's tweets? (Question {i+1})"
                                if "options" not in q or len(q["options"]) != 4:
                                    q["options"] = ["AI", "Blockchain", "NFTs", "Travel"]
                                if "correct_answer" not in q or not (0 <= q["correct_answer"] <= 3):
                                    q["correct_answer"] = 0
                    else:
                        time.sleep(2)
                        continue

                for q in questions:
                    correct_answer = q["options"][q["correct_answer"]]
                    q["hash"] = "0x" + sha256((q["question"] + correct_answer).encode()).hexdigest()

                assert len(questions) == num_questions, f"Expected {num_questions} questions, got {len(questions)}"
                return questions

            except Exception as e:
                print(f"Error on attempt {attempt + 1}: {str(e)}", file=sys.stderr)
                sys.stderr.flush()
                if attempt == max_retries - 1:
                    if 'questions' in locals() and isinstance(questions, list) and questions:
                        for q in questions:
                            if "hash" not in q:
                                correct_answer = q["options"][q["correct_answer"]]
                                q["hash"] = "0x" + sha256((q["question"] + correct_answer).encode()).hexdigest()
                        return questions[:num_questions] if len(questions) >= num_questions else questions
                    return []
                time.sleep(2)

        return []

if __name__ == "__main__":
    try:
        if len(sys.argv) > 1:
            tweets = json.loads(sys.argv[1])
        else:
            try:
                with open("ai/mock_tweets.json", "r") as f:
                    tweets = json.load(f)
            except FileNotFoundError:
                print("Error: mock_tweets.json not found", file=sys.stderr)
                sys.exit(1)
            except json.JSONDecodeError:
                print("Error: Invalid JSON in mock_tweets.json", file=sys.stderr)
                sys.exit(1)

        generator = QuestionGenerator()
        questions = generator.generate_questions(tweets)
        print(json.dumps(questions, indent=2))
    except Exception as e:
        print(f"Main error: {str(e)}", file=sys.stderr)
        sys.exit(1)