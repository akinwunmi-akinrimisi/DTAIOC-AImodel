from question_generator import QuestionGenerator
import json

def test_generate_questions():
    # Load mock tweets
    try:
        with open("ai/mock_tweets.json", "r") as f:
            tweets = json.load(f)
    except FileNotFoundError:
        print("Error: mock_tweets.json not found")
        return
    except json.JSONDecodeError:
        print("Error: Invalid JSON in mock_tweets.json")
        return

    if not tweets:
        print("No tweets to generate questions")
        return

    # Generate questions
    generator = QuestionGenerator()
    questions = generator.generate_questions(tweets)
    print(f"Generated {len(questions)} questions:")
    for q in questions[:3]:  # Show first 3 questions
        print(json.dumps(q, indent=2))
    assert len(questions) == 15, f"Expected 15 questions, got {len(questions)}"
    assert all(
        "question" in q and
        "options" in q and len(q["options"]) == 4 and
        "correct_answer" in q and 0 <= q["correct_answer"] <= 3 and
        "hash" in q and q["hash"].startswith("0x")
        for q in questions
    ), "Invalid question format"

if __name__ == "__main__":
    test_generate_questions()