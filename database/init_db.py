import os
import psycopg2
from psycopg2 import sql
from urllib.parse import urlparse

# Database connection parameters from environment variables
db_params = {
    'user': os.getenv('DB_USER'),
    'password': os.getenv('DB_PASSWORD'),
    'host': os.getenv('DB_HOST'),
    'port': os.getenv('DB_PORT'),
    'database': os.getenv('DB_NAME'),
    'sslmode': 'require'
}

def create_tables():
    try:
        # Connect to PostgreSQL
        conn = psycopg2.connect(**db_params)
        cursor = conn.cursor()

        # Create users table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS users (
                username TEXT PRIMARY KEY,
                access_token TEXT,
                refresh_token TEXT,
                expires_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                wallet_address TEXT
            );
        """)

        # Ensure wallet_address column exists
        cursor.execute("""
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS wallet_address TEXT;
        """)

        # Create games table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS games (
                id SERIAL PRIMARY KEY,
                basename TEXT NOT NULL,
                stake_amount INTEGER NOT NULL,
                player_limit INTEGER NOT NULL,
                duration INTEGER NOT NULL,
                status TEXT NOT NULL,
                end_time TIMESTAMP NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """)

        # Create questions table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS questions (
                id SERIAL PRIMARY KEY,
                game_id INTEGER REFERENCES games(id),
                question_text TEXT NOT NULL,
                options TEXT[] NOT NULL,
                correct_answer TEXT NOT NULL,
                hash TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """)

        # Create game_participants table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS game_participants (
                game_id INTEGER REFERENCES games(id),
                username TEXT REFERENCES users(username),
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (game_id, username)
            );
        """)

        # Create submissions table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS submissions (
                id SERIAL PRIMARY KEY,
                game_id INTEGER REFERENCES games(id),
                username TEXT REFERENCES users(username),
                stage INTEGER NOT NULL,
                score INTEGER NOT NULL,
                answer_hashes TEXT[] NOT NULL,
                submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """)

        # Commit changes
        conn.commit()
        print("Database tables created successfully")

    except Exception as e:
        print(f"Error creating tables: {e}")
        conn.rollback()
    finally:
        cursor.close()
        conn.close()

if __name__ == "__main__":
    create_tables()