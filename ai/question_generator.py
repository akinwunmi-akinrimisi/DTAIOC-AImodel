import sys
import os
import json
import re
import time
from hashlib import sha256
from dotenv import load_dotenv
import httpx
from openai import OpenAI

# Load environment variables
load_dotenv()

# Debug environment variables
print("Checking environment variables for proxy settings:", file=sys.stderr)
for key, value in os.environ.items():
    if "PROXY" in key.upper() or "OPENAI" in key.upper():
        print(f"{key}: {value}", file=sys.stderr)

# Remove proxy-related environment variables
proxy_related_keys = [key for key in os.environ.keys() if "PROXY" in key.upper()]
for key in proxy_related_keys:
    print(f"Removing environment variable: {key}", file=sys.stderr)
    del os.environ[key]

# Check API key
api_key = os.getenv("OPENAI_API_KEY")
if not api_key:
    print("Error: OPENAI_API_KEY not set in environment", file=sys.stderr)
    sys.exit(1)

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
            # Create custom httpx client without proxies parameter
            print("Creating custom httpx.Client", file=sys.stderr)
            custom_client = httpx.Client()
            # Initialize OpenAI client with custom httpx client
            print("Initializing OpenAI client with API key and custom httpx client", file=sys.stderr)
            self.client = OpenAI(api_key=api_key, http_client=custom_client)
            print("OpenAI client initialized successfully", file=sys.stderr)
        except Exception as e:
            print(f"Error initializing OpenAI client: {str(e)}", file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)
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
                print(f"Attempt {attempt + 1}: Sending request to OpenAI", file=sys.stderr)
                response = self.client.chat.completions.create(
                    model="gpt-4o-mini",
                    messages=[{"role": "user", "content": prompt}],
                    max_tokens=3000,
                    temperature=0.7
                )
                print("Successfully received response from OpenAI", file=sys.stderr)
                content = response.choices[0].message.content.strip()
                try:
                    cleaned_content = clean_json_response(content)
                    questions = json.loads(cleaned_content)
                except (ValueError, json.JSONDecodeError) as e:
                    print(f"Invalid JSON response on attempt {attempt + 1}: {str(e)}", file=sys.stderr)
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
                    except Exception as e:
                        print(f"Failed to add additional questions: {e}", file=sys.stderr)

                if len(questions) > num_questions:
                    questions = questions[:num_questions]

                for q in questions:
                    correct_answer = q["options"][q["correct_answer"]]
                    q["hash"] = "0x" + sha256((q["question"] + correct_answer).encode()).hexdigest()

                assert len(questions) == num_questions, f"Expected {num_questions} questions, got {len(questions)}"
                return questions

            except Exception as e:
                print(f"Error on attempt {attempt + 1}: {str(e)}", file=sys.stderr)
                import traceback
                traceback.print_exc(file=sys.stderr)
                if attempt == max_retries - 1:
                    return questions[:num_questions] if 'questions' in locals() and len(questions) >= num_questions else []
                time.sleep(2)

        return []

if __name__ == "__main__":
    try:
        print("Starting question generator script", file=sys.stderr)
        if len(sys.argv) != 2:
            print("Error: Expected a file path as argument", file=sys.stderr)
            sys.exit(1)

        file_path = sys.argv[1]
        print(f"Reading tweets from file: {file_path}", file=sys.stderr)
        try:
            with open(file_path, 'r') as f:
                tweets = json.load(f)
            print(f"Loaded {len(tweets)} tweets from {file_path}", file=sys.stderr)
        except FileNotFoundError:
            print(f"Error: File {file_path} not found", file=sys.stderr)
            sys.exit(1)
        except json.JSONDecodeError as e:
            print(f"Error: Invalid JSON in {file_path}: {str(e)}", file=sys.stderr)
            sys.exit(1)

        print("Creating QuestionGenerator instance", file=sys.stderr)
        generator = QuestionGenerator()
        print("Generating questions", file=sys.stderr)
        questions = generator.generate_questions(tweets)
        print(f"Generated {len(questions)} questions", file=sys.stderr)
        print(json.dumps(questions, indent=2))
    except Exception as e:
        print(f"Main error: {str(e)}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)