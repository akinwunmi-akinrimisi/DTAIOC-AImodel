import psycopg2
from psycopg2 import sql
import os
from dotenv import load_dotenv

load_dotenv('config/.env')

def init_db():
    try:
        conn = psycopg2.connect(
            dbname=os.getenv("DB_NAME"),
            user=os.getenv("DB_USER"),
            password=os.getenv("DB_PASSWORD"),
            host=os.getenv("DB_HOST"),
            port=os.getenv("DB_PORT")
        )
        cursor = conn.cursor()

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS games (
                id SERIAL PRIMARY KEY,
                creator_basename VARCHAR(255) NOT NULL,
                stake_amount INTEGER NOT NULL,
                player_limit INTEGER NOT NULL,
                duration INTEGER NOT NULL,
                ipfs_cid VARCHAR(255)
            );
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS questions (
                id SERIAL PRIMARY KEY,
                game_id INTEGER REFERENCES games(id),
                stage INTEGER NOT NULL,
                question TEXT NOT NULL,
                options JSONB NOT NULL,
                correct_answer INTEGER NOT NULL,
                hash VARCHAR(66) NOT NULL,
                ipfs_cid VARCHAR(255)
            );
        """)

        conn.commit()
        print("Database initialized successfully")
    except Exception as e:
        print(f"Error initializing database: {e}")
    finally:
        cursor.close()
        conn.close()

if __name__ == "__main__":
    init_db()