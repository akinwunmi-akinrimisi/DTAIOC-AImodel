import psycopg2
from psycopg2 import sql
import os
from dotenv import load_dotenv
from answer_validator import validate_answers

load_dotenv('config/.env')

def test_validate_answers():
    # Connect to database to get a game_id and question hashes
    conn = psycopg2.connect(
        dbname=os.getenv("DB_NAME"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD"),
        host=os.getenv("DB_HOST"),
        port=os.getenv("DB_PORT")
    )
    cursor = conn.cursor()
    
    # Get a game_id (use the latest game from test_end_to_end.py)
    cursor.execute("SELECT id FROM games ORDER BY id DESC LIMIT 1")
    game_id = cursor.fetchone()[0]
    
    # Get correct hashes for stage 1
    cursor.execute(
        sql.SQL("SELECT hash FROM questions WHERE game_id = %s AND stage = %s"),
        (game_id, 1)
    )
    correct_hashes = [row[0] for row in cursor.fetchall()]
    
    cursor.close()
    conn.close()
    
    # Test with correct answers
    score = validate_answers(game_id, 1, correct_hashes)
    print(f"Score for correct answers: {score}")
    assert score == 5, f"Expected score of 5, got {score}"
    
    # Test with incorrect answers
    incorrect_hashes = ["0xwrong"] * 5
    score = validate_answers(game_id, 1, incorrect_hashes)
    print(f"Score for incorrect answers: {score}")
    assert score == 0, f"Expected score of 0, got {score}"
    
    print("Answer validator test passed!")

if __name__ == "__main__":
    test_validate_answers()