import sys
import os
import json
import re
import time
from hashlib import sha256
from dotenv import load_dotenv
import httpx
from openai import OpenAI
import logging

# Configure logging
logging.basicConfig(level=logging.INFO, stream=sys.stderr)
logger = logging.getLogger(__name__)

# Load environment variables
load_dotenv(dotenv_path="config/.env")

# Debug environment variables
logger.info("Checking environment variables for proxy settings:")
for key, value in os.environ.items():
    if "PROXY" in key.upper() or "OPENAI" in key.upper():
        logger.info(f"{key}: {'<hidden>' if 'OPENAI' in key.upper() else value}")

# Remove proxy-related environment variables
proxy_related_keys = [key for key in os.environ.keys() if "PROXY" in key.upper()]
for key in proxy_related_keys:
    logger.info(f"Removing environment variable: {key}")
    del os.environ[key]

# Check API key
api_key = os.getenv("OPENAI_API_KEY")
if not api_key:
    logger.error("OPENAI_API_KEY not set in environment")
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
            logger.info("Creating custom httpx.Client")
            custom_client = httpx.Client(timeout=30.0)
            logger.info("Initializing OpenAI client with API key and custom httpx client")
            self.client = OpenAI(api_key=api_key, http_client=custom_client)
            logger.info("OpenAI client initialized successfully")
        except Exception as e:
            logger.error(f"Error initializing OpenAI client: {str(e)}")
            import traceback
            traceback.print_exc(file=sys.stderr)
            sys.exit(1)

    def generate_questions(self, tweets, username, num_questions=15, max_retries=3):
        # Normalize tweet format
        normalized_tweets = []
        for tweet in tweets:
            if isinstance(tweet, str):
                normalized_tweets.append({"text": tweet, "created_at": "Unknown"})
            elif isinstance(tweet, dict):
                text = tweet.get('text', '')
                created_at = tweet.get('created_at', 'Unknown')
                normalized_tweets.append({"text": text, "created_at": created_at})
            else:
                logger.warning(f"Skipping invalid tweet format: {tweet}")
                continue

        if not normalized_tweets:
            logger.warning("No valid tweets provided")
            return []

        tweet_text = "\n".join([f"{t['created_at']}: {t['text']}" for t in normalized_tweets])
        prompt = f"""
Your task is to generate EXACTLY {num_questions} unique trivia questions with 4 multiple-choice answers each based on the following tweets.

IMPORTANT: You MUST generate EXACTLY {num_questions} questions - no more, no less. The questions should be engaging, technically accurate, and suitable for a general audience interested in the tweet topics (e.g., events, technologies, organizations, music, social issues). Avoid redundant questions (e.g., repeating the same topic or entity; cap questions on any single theme to 3). Prefix each question with 'According to {username}\\'s tweets' to clarify answers reflect the creator's words, not verified truths. Ensure answers are directly supported by tweet text; do not infer roles for mentioned names unless explicitly stated. Frame inferred answers as 'implied' or 'suggested' to avoid assumptions. Do not assume specific user interests; focus on the tweet content.

For tweets about KYC, prioritize 'securely' as the ideal duration over speed. If tweets lack enough content, create plausible questions related to the mentioned topics (e.g., blockchain, DeFi, music charts, social events).

Return a JSON array of EXACTLY {num_questions} objects, each with:
- 'question': The trivia question
- 'options': Array of 4 strings representing possible answers
- 'correct_answer': The correct answer as a string (not an index)
- 'hash': SHA256 of question + correct answer (leave this blank, it will be added later)

Output only the JSON array, without Markdown code fences or extra text.

Tweets:
{tweet_text}

Example of expected format:
[
    {{
        "question": "According to {username}\\'s tweets, what technology is mentioned for enhancing KYC processes?",
        "options": ["AI", "Zero-knowledge proofs", "Cloud computing", "IoT"],
        "correct_answer": "Zero-knowledge proofs",
        "hash": ""
    }},
    {{
        "question": "According to {username}\\'s tweets, which event is mentioned?",
        "options": ["ETHGlobal", "Basecamp 12", "Devcon", "Consensus"],
        "correct_answer": "Basecamp 12",
        "hash": ""
    }}
]
"""
        for attempt in range(max_retries):
            try:
                logger.info(f"Attempt {attempt + 1}: Sending request to OpenAI")
                response = self.client.chat.completions.create(
                    model="gpt-4o-mini",
                    messages=[{"role": "user", "content": prompt}],
                    max_tokens=3000,
                    temperature=0.7
                )
                logger.info("Successfully received response from OpenAI")
                content = response.choices[0].message.content.strip()
                try:
                    cleaned_content = clean_json_response(content)
                    questions = json.loads(cleaned_content)
                except (ValueError, json.JSONDecodeError) as e:
                    logger.error(f"Invalid JSON response on attempt {attempt + 1}: {str(e)}")
                    if attempt == max_retries - 1:
                        raise ValueError(f"Failed to parse JSON after {max_retries} attempts: {str(e)}")
                    time.sleep(2)
                    continue

                if not isinstance(questions, list):
                    logger.error(f"Error on attempt {attempt + 1}: Expected list, got {type(questions)}")
                    if attempt == max_retries - 1:
                        raise ValueError("Response is not a list")
                    time.sleep(2)
                    continue

                if len(questions) < num_questions:
                    missing = num_questions - len(questions)
                    logger.info(f"Generating {missing} additional questions")
                    additional_prompt = f"""
Based on these tweets, generate exactly {missing} more unique trivia questions with 4 multiple-choice answers each.
Make them different from these existing questions:
{json.dumps(questions, indent=2)}
Focus on the tweet content (e.g., technologies, events, organizations, music, social issues). Prefix each question with 'According to {username}\\'s tweets'. Ensure answers are directly supported by tweet text; do not infer roles for mentioned names unless explicitly stated. Cap questions on any single theme to 3. Frame inferred answers as 'implied' or 'suggested'.

Tweets:
{tweet_text}

Return ONLY a JSON array with exactly {missing} question objects, each with 'question', 'options', 'correct_answer' (as string), and 'hash' (blank).
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
                        logger.error(f"Failed to add additional questions: {e}")
                        if attempt == max_retries - 1:
                            raise ValueError(f"Failed to add additional questions: {e}")

                if len(questions) > num_questions:
                    questions = questions[:num_questions]

                # Validate and normalize questions
                for q in questions:
                    if not all(key in q for key in ['question', 'options', 'correct_answer', 'hash']):
                        logger.warning(f"Invalid question format: {q}")
                        continue
                    if not isinstance(q['options'], list) or len(q['options']) != 4:
                        logger.warning(f"Invalid options format: {q['options']}")
                        continue
                    if q['correct_answer'] not in q['options']:
                        logger.warning(f"Correct answer not in options: {q['correct_answer']}")
                        continue
                    q['hash'] = "0x" + sha256((q["question"] + q["correct_answer"]).encode()).hexdigest()

                if len(questions) == num_questions:
                    logger.info(f"Generated {len(questions)} questions")
                    return questions
                else:
                    logger.error(f"Expected {num_questions} questions, got {len(questions)}")
                    if attempt == max_retries - 1:
                        return questions[:num_questions] if len(questions) >= num_questions else []
                    time.sleep(2)

            except Exception as e:
                logger.error(f"Error on attempt {attempt + 1}: {str(e)}")
                import traceback
                traceback.print_exc(file=sys.stderr)
                if attempt == max_retries - 1:
                    return questions[:num_questions] if 'questions' in locals() and len(questions) >= num_questions else []
                time.sleep(2)

        logger.error("Failed to generate questions after all retries")
        return []

def main():
    logger.info("Starting question generator script")
    if len(sys.argv) < 2:
        logger.error("Expected a file path as argument")
        sys.exit(1)

    file_path = sys.argv[1]
    logger.info(f"Reading tweets from file: {file_path}")
    try:
        with open(file_path, 'r') as f:
            data = json.load(f)
        if 'username' in data and 'tweets' in data:
            username = data['username']
            tweets = data['tweets']
        else:
            username = sys.argv[2] if len(sys.argv) > 2 else "unknown"
            tweets = data
        logger.info(f"Loaded {len(tweets)} tweets from {file_path}")
        logger.info(f"Using username: {username}")
    except FileNotFoundError:
        logger.error(f"File {file_path} not found")
        sys.exit(1)
    except json.JSONDecodeError as e:
        logger.error(f"Invalid JSON in {file_path}: {str(e)}")
        sys.exit(1)

    logger.info("Creating QuestionGenerator instance")
    generator = QuestionGenerator()
    logger.info(f"Generating questions for username: {username}")
    questions = generator.generate_questions(tweets, username)
    logger.info(f"Generated {len(questions)} questions")
    print(json.dumps(questions, indent=2))

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        logger.error(f"Main error: {str(e)}")
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)