from question_generator import QuestionGenerator
import json

def test_generate_questions():
    try:
        with open("ai/user1.json", "r") as f:
            data = json.load(f)
        if 'username' not in data or 'tweets' not in data:
            print("Error: Invalid format in user1.json")
            return
        tweets = data['tweets']
        username = data['username']
    except FileNotFoundError:
        print("Error: user1.json not found")
        return
    except json.JSONDecodeError:
        print("Error: Invalid JSON in user1.json")
        return

    if not tweets:
        print("No tweets to generate questions")
        return

    generator = QuestionGenerator()
    questions = generator.generate_questions(tweets, username)
    print(f"Generated {len(questions)} questions:")
    for q in questions[:3]:
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