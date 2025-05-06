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
        prompt = f"""
Given the following tweets from a user, generate {num_questions} trivia questions with 4 multiple-choice answers each. Questions should be based on tweet content, such as events, mentions, or interests. Ensure questions are engaging and answerable by someone familiar with the user's public activity. Return a JSON array of objects with 'question', 'options' (array of 4 strings), 'correct_answer' (index 0-3), and 'hash' (SHA256 of question + correct answer). Output only the JSON array, without Markdown code fences or extra text.

Tweets:
{tweet_text}

Example output:
[
    {{
        "question": "Which event did the user tweet about in July?",
        "options": ["Conference", "Birthday", "Concert", "Meeting"],
        "correct_answer": 0,
        "hash": "0x..."
    }}
]
"""
        for attempt in range(max_retries):
            try:
                response = self.client.chat.completions.create(
                    model="gpt-4o-mini",
                    messages=[{"role": "user", "content": prompt}],
                    max_tokens=2000
                )
                content = response.choices[0].message.content.strip()
                # Clean Markdown and validate JSON
                try:
                    cleaned_content = clean_json_response(content)
                    questions = json.loads(cleaned_content)
                except (ValueError, json.JSONDecodeError) as e:
                    print(f"Invalid JSON response on attempt {attempt + 1}: {content}")
                    if attempt == max_retries - 1:
                        raise ValueError(f"Failed to parse JSON after {max_retries} attempts: {str(e)}")
                    time.sleep(2)
                    continue

                # Validate question format
                if not isinstance(questions, list) or not all(
                    isinstance(q, dict) and
                    "question" in q and
                    "options" in q and len(q["options"]) == 4 and
                    "correct_answer" in q and 0 <= q["correct_answer"] <= 3
                    for q in questions
                ):
                    raise ValueError("Invalid question format")

                # Add hashes
                for q in questions:
                    correct_answer = q["options"][q["correct_answer"]]
                    q["hash"] = "0x" + sha256((q["question"] + correct_answer).encode()).hexdigest()
                return questions[:num_questions]  # Ensure exact number
            except Exception as e:
                print(f"Error on attempt {attempt + 1}: {e}")
                if attempt == max_retries - 1:
                    print(f"Failed after {max_retries} attempts")
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