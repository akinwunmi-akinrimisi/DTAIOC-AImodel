import psycopg2
from psycopg2 import sql
import os
from dotenv import load_dotenv

load_dotenv('config/.env')

def validate_answers(game_id, stage, answer_hashes):
    try:
        conn = psycopg2.connect(
            dbname=os.getenv("DB_NAME"),
            user=os.getenv("DB_USER"),
            password=os.getenv("DB_PASSWORD"),
            host=os.getenv("DB_HOST"),
            port=os.getenv("DB_PORT")
        )
        cursor = conn.cursor()

        cursor.execute(
            sql.SQL("SELECT hash FROM questions WHERE game_id = %s AND stage = %s"),
            (game_id, stage)
        )
        correct_hashes = [row[0] for row in cursor.fetchall()]

        score = sum(1 for i, hash in enumerate(answer_hashes) if hash == correct_hashes[i])

        cursor.close()
        conn.close()
        return score
    except Exception as e:
        print(f"Error validating answers: {e}")
        return 0