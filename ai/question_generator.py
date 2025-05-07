from openai import OpenAI
from dotenv import load_dotenv
import os
import json
from hashlib import sha256
import sys
import time
import re

# Explicitly load config/.env
env_path = os.path.join("config", ".env")
if not os.path.exists(env_path):
    print(f"Error: {env_path} does not exist")
    sys.exit(1)
success = load_dotenv(env_path)
# Only print debug logs when run standalone (no command-line args)
if len(sys.argv) == 1:
    print(f"load_dotenv success: {success}")
    print(f"OPENAI_API_KEY: {os.getenv('OPENAI_API_KEY')[:10]}...")  # Partial key for safety

def clean_json_response(content):
    """Remove Markdown code fences and leading/trailing text from JSON response."""
    # Remove Markdown code fences
    content = re.sub(r'^```json\s*|\s*```$', '', content, flags=re.MULTILINE)
    # Remove any leading/trailing whitespace or text
    content = content.strip()
    # Ensure content starts with [ and ends with ]
    if not content.startswith('[') or not content.endswith(']'):
        raise ValueError("Response does not contain valid JSON array")
    return content

class QuestionGenerator:
    def __init__(self):
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise ValueError("OPENAI_API_KEY not set in .env")
        self.client = OpenAI(api_key=api_key)

    def generate_questions(self, tweets, num_questions=15, max_retries=3):
        tweet_text = "\n".join([f"{t['created_at']}: {t['text']}" for t in tweets])
        
        # Modified prompt to emphasize the exact count requirement and provide more guidance
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
                    max_tokens=3000,  # Increased token limit to ensure full response
                    temperature=0.7   # Slight randomness to encourage creativity for more questions
                )
                content = response.choices[0].message.content.strip()
                
                # Clean Markdown and validate JSON
                try:
                    cleaned_content = clean_json_response(content)
                    questions = json.loads(cleaned_content)
                except (ValueError, json.JSONDecodeError) as e:
                    print(f"Invalid JSON response on attempt {attempt + 1}: {str(e)}")
                    print(f"Raw content: {content[:200]}...")  # Print first 200 chars for debugging
                    if attempt == max_retries - 1:
                        raise ValueError(f"Failed to parse JSON after {max_retries} attempts: {str(e)}")
                    time.sleep(2)
                    continue

                # Validate question count
                if not isinstance(questions, list):
                    print(f"Error on attempt {attempt + 1}: Expected list, got {type(questions)}")
                    if attempt == max_retries - 1:
                        raise ValueError("Response is not a list")
                    time.sleep(2)
                    continue
                
                # Check if we got the right number of questions
                if len(questions) < num_questions:
                    print(f"Warning: Only got {len(questions)} questions, expected {num_questions}")
                    
                    # If we're close (within 2 questions), generate additional questions to fill the gap
                    if num_questions - len(questions) <= 2 and attempt < max_retries - 1:
                        missing = num_questions - len(questions)
                        print(f"Generating {missing} additional questions...")
                        
                        # Create a prompt specifically to generate the missing questions
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
                            print(f"Successfully added {len(additional_questions)} questions")
                        except Exception as e:
                            print(f"Failed to add additional questions: {e}")
                            
                    # If we still don't have enough and it's the last retry, generate synthetic questions
                    if len(questions) < num_questions and attempt == max_retries - 1:
                        missing = num_questions - len(questions)
                        print(f"Generating {missing} synthetic questions...")
                        
                        # Create generic questions to fill the gap
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
                
                # Handle too many questions by trimming
                if len(questions) > num_questions:
                    print(f"Trimming from {len(questions)} to {num_questions} questions")
                    questions = questions[:num_questions]
                
                # Validate question format
                invalid_questions = [
                    i for i, q in enumerate(questions) 
                    if not (isinstance(q, dict) and 
                           "question" in q and 
                           "options" in q and len(q["options"]) == 4 and 
                           "correct_answer" in q and 0 <= q["correct_answer"] <= 3)
                ]
                
                if invalid_questions:
                    print(f"Error on attempt {attempt + 1}: Invalid format in questions {invalid_questions}")
                    if attempt == max_retries - 1:
                        # Fix any invalid questions on the last attempt
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

                # Add hashes
                for q in questions:
                    correct_answer = q["options"][q["correct_answer"]]
                    q["hash"] = "0x" + sha256((q["question"] + correct_answer).encode()).hexdigest()
                
                # Final verification of count
                assert len(questions) == num_questions, f"Expected {num_questions} questions, got {len(questions)}"
                
                return questions
                
            except Exception as e:
                print(f"Error on attempt {attempt + 1}: {e}")
                if attempt == max_retries - 1:
                    print(f"Failed after {max_retries} attempts")
                    # Return whatever questions we have on final failure
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
    if len(sys.argv) > 1:
        tweets = json.loads(sys.argv[1])
    else:
        try:
            with open("ai/mock_tweets.json", "r") as f:
                tweets = json.load(f)
        except FileNotFoundError:
            print("Error: mock_tweets.json not found")
            sys.exit(1)
        except json.JSONDecodeError:
            print("Error: Invalid JSON in mock_tweets.json")
            sys.exit(1)

    generator = QuestionGenerator()
    questions = generator.generate_questions(tweets)
    print(json.dumps(questions, indent=2))