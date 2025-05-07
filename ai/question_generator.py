import sys
import os
import json
import re
import time
from hashlib import sha256
from dotenv import load_dotenv

# Load environment variables first
load_dotenv()

# Debug environment variables to see what might be affecting the OpenAI client
print("Checking environment variables for proxy settings:", file=sys.stderr)
for key, value in os.environ.items():
    if "PROXY" in key.upper() or "OPENAI" in key.upper():
        print(f"{key}: {value}", file=sys.stderr)

# Remove any proxy-related environment variables that might be causing issues
proxy_related_keys = [key for key in os.environ.keys() if "PROXY" in key.upper()]
for key in proxy_related_keys:
    print(f"Removing environment variable: {key}", file=sys.stderr)
    del os.environ[key]

# Check API key after cleaning environment
api_key = os.getenv("OPENAI_API_KEY")
if not api_key:
    print("Error: OPENAI_API_KEY not set in environment", file=sys.stderr)
    sys.exit(1)

# Now import OpenAI after cleaning the environment
try:
    from openai import OpenAI
except ImportError:
    print("Error importing OpenAI package. Make sure it's installed correctly.", file=sys.stderr)
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
            # Initialize OpenAI client with only the api_key parameter
            # No additional parameters that might cause conflicts
            print("Initializing OpenAI client with API key only", file=sys.stderr)
            
            # Create client explicitly without any extra parameters
            self.client = OpenAI(api_key=api_key)
            
            print("OpenAI client initialized successfully", file=sys.stderr)
        except TypeError as e:
            print(f"TypeError initializing OpenAI client: {str(e)}", file=sys.stderr)
            print("Attempting alternative initialization...", file=sys.stderr)
            try:
                # Try alternative initialization method
                import openai
                openai.api_key = api_key
                self.client = openai.OpenAI()
                print("OpenAI client initialized with alternative method", file=sys.stderr)
            except Exception as e2:
                print(f"Failed alternative initialization: {str(e2)}", file=sys.stderr)
                import traceback
                traceback.print_exc(file=sys.stderr)
                sys.exit(1)
        except Exception as e:
            print(f"Error initializing OpenAI client: {str(e)}", file=sys.stderr)
            # Print more details about the exception
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
        questions = []
        for attempt in range(max_retries):
            try:
                print(f"Attempt {attempt + 1}: Sending request to OpenAI", file=sys.stderr)
                
                try:
                    # First attempt with regular client method
                    response = self.client.chat.completions.create(
                        model="gpt-4o-mini",
                        messages=[{"role": "user", "content": prompt}],
                        max_tokens=3000,
                        temperature=0.7
                    )
                    print("Successfully received response from OpenAI", file=sys.stderr)
                    content = response.choices[0].message.content.strip()
                except (AttributeError, TypeError) as e:
                    # Fall back to older API style if needed
                    print(f"Error with standard method: {str(e)}. Trying alternative API call...", file=sys.stderr)
                    import openai
                    response = openai.ChatCompletion.create(
                        model="gpt-4o-mini",
                        messages=[{"role": "user", "content": prompt}],
                        max_tokens=3000,
                        temperature=0.7
                    )
                    print("Successfully received response from OpenAI (alt method)", file=sys.stderr)
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
                    try:
                        additional_response = self.client.chat.completions.create(
                            model="gpt-4o-mini",
                            messages=[{"role": "user", "content": additional_prompt}],
                            max_tokens=1000
                        )
                        additional_content = additional_response.choices[0].message.content.strip()
                    except (AttributeError, TypeError):
                        # Fall back to older API style if needed
                        import openai
                        additional_response = openai.ChatCompletion.create(
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

                # Add hash to each question
                for q in questions:
                    if "correct_answer" not in q or not isinstance(q["correct_answer"], int):
                        print(f"Warning: Invalid question format: {q}", file=sys.stderr)
                        q["correct_answer"] = 0  # Default to first answer if invalid
                    
                    # Ensure correct_answer is within bounds
                    if q["correct_answer"] >= len(q["options"]):
                        q["correct_answer"] = 0
                        
                    correct_answer = q["options"][q["correct_answer"]]
                    q["hash"] = "0x" + sha256((q["question"] + correct_answer).encode()).hexdigest()

                # Verify we have exactly the right number of questions
                if len(questions) == num_questions:
                    return questions
                else:
                    print(f"Wrong number of questions: {len(questions)}, expected {num_questions}", file=sys.stderr)
                    if attempt == max_retries - 1:
                        # If this is our last attempt, pad or truncate to exact number
                        if len(questions) < num_questions:
                            # Pad with duplicates if needed (not ideal but ensures correct count)
                            while len(questions) < num_questions:
                                clone = questions[0].copy()
                                clone["question"] = f"FILLER: {clone['question']}"
                                clone["hash"] = "0x" + sha256((clone["question"] + clone["options"][clone["correct_answer"]]).encode()).hexdigest()
                                questions.append(clone)
                        return questions[:num_questions]

            except Exception as e:
                print(f"Error on attempt {attempt + 1}: {str(e)}", file=sys.stderr)
                # Print more details about the exception
                import traceback
                traceback.print_exc(file=sys.stderr)
                if attempt == max_retries - 1:
                    # If we have any questions at all, return what we have (up to num_questions)
                    if 'questions' in locals() and isinstance(questions, list) and len(questions) > 0:
                        return questions[:num_questions] if len(questions) >= num_questions else questions
                    else:
                        # Generate minimal dummy questions as a last resort
                        return self._generate_fallback_questions(num_questions)
                time.sleep(2)

        # Should never reach here, but just in case
        return self._generate_fallback_questions(num_questions)
    
    def _generate_fallback_questions(self, num_questions):
        """Generate fallback questions if API calls completely fail"""
        questions = []
        for i in range(num_questions):
            q = {
                "question": f"Fallback question #{i+1} (API error occurred)",
                "options": ["Option A", "Option B", "Option C", "Option D"],
                "correct_answer": 0,
                "hash": ""
            }
            q["hash"] = "0x" + sha256((q["question"] + q["options"][0]).encode()).hexdigest()
            questions.append(q)
        return questions

if __name__ == "__main__":
    try:
        print("Starting question generator script", file=sys.stderr)
        if len(sys.argv) > 1:
            tweets = json.loads(sys.argv[1])
            print(f"Loaded {len(tweets)} tweets from command line argument", file=sys.stderr)
        else:
            try:
                with open("ai/mock_tweets.json", "r") as f:
                    tweets = json.load(f)
                    print(f"Loaded {len(tweets)} tweets from mock_tweets.json", file=sys.stderr)
            except FileNotFoundError:
                print("Error: mock_tweets.json not found", file=sys.stderr)
                sys.exit(1)

        print("Creating QuestionGenerator instance", file=sys.stderr)
        generator = QuestionGenerator()
        print("Generating questions", file=sys.stderr)
        questions = generator.generate_questions(tweets)
        print(f"Generated {len(questions)} questions", file=sys.stderr)
        print(json.dumps(questions, indent=2))
    except Exception as e:
        print(f"Main error: {str(e)}", file=sys.stderr)
        # Print more details about the exception
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)