import requests
import json
import psycopg2
from psycopg2 import sql
import os
from dotenv import load_dotenv

load_dotenv('config/.env')

def test_end_to_end():
    response = requests.post(
        "http://localhost:3000/games",
        json={
            "basename": "creator.base.eth",
            "stakeAmount": 10,
            "playerLimit": 50,
            "duration": 3600
        }
    )
    assert response.status_code == 200, f"Game creation failed: {response.text}"
    game_data = response.json()
    game_id = game_data["gameId"]
    question_hashes = game_data["questionHashes"]
    ipfs_cid = game_data["ipfsCid"]
    print(f"Created game {game_id} with {len(question_hashes)} question hashes, IPFS CID: {ipfs_cid}")

    conn = psycopg2.connect(
        dbname=os.getenv("DB_NAME"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD"),
        host=os.getenv("DB_HOST"),
        port=os.getenv("DB_PORT")
    )
    cursor = conn.cursor()
    cursor.execute(
        sql.SQL("SELECT hash, ipfs_cid FROM questions WHERE game_id = %s AND stage = %s"),
        (game_id, 1)
    )
    db_questions = cursor.fetchall()
    cursor.close()
    conn.close()
    assert len(db_questions) == 5, "Expected 5 questions for stage 1"
    assert all(q[1] == ipfs_cid for q in db_questions), "IPFS CID mismatch in questions"

    ipfs_url = f"https://gateway.pinata.cloud/ipfs/{ipfs_cid}"
    ipfs_response = requests.get(ipfs_url)
    assert ipfs_response.status_code == 200, f"Failed to fetch questions from IPFS: {ipfs_response.text}"
    ipfs_questions = ipfs_response.json()
    assert len(ipfs_questions) == 15, "Expected 15 questions on IPFS"

    db_hashes = [q[0] for q in db_questions]
    response = requests.post(
        f"http://localhost:3000/games/{game_id}/submit",
        json={
            "stage": 1,
            "answerHashes": db_hashes
        }
    )
    assert response.status_code == 200, f"Answer submission failed: {response.text}"
    score = response.json()["score"]
    print(f"Score for correct answers: {score}")
    assert score == 5, "Expected score of 5 for correct answers"

    response = requests.post(
        f"http://localhost:3000/games/{game_id}/submit",
        json={
            "stage": 1,
            "answerHashes": ["0xwrong"] * 5
        }
    )
    score = response.json()["score"]
    print(f"Score for incorrect answers: {score}")
    assert score == 0, "Expected score of 0 for incorrect answers"

if __name__ == "__main__":
    test_end_to_end()