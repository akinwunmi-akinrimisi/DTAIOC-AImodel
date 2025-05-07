const express = require('express');
const { Pool } = require('pg');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const { execSync } = require('child_process');
const fetch = require('node-fetch');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, 'config/.env') });

const app = express();
app.use(express.json());

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

const rateLimiter = new RateLimiterMemory({
    points: 10,
    duration: 60,
});

async function uploadToIPFS(data) {
    try {
        const response = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.PINATA_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data),
        });

        if (!response.ok) {
            throw new Error(`Pinata API error: ${response.statusText}`);
        }

        const result = await response.json();
        return result.IpfsHash;
    } catch (e) {
        throw new Error(`Pinata upload failed: ${e.message}`);
    }
}

app.post('/games', async (req, res) => {
    try {
        await rateLimiter.consume(req.ip);
        const { basename, stakeAmount, playerLimit, duration } = req.body;
        if (!basename || !stakeAmount || !playerLimit || !duration) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const tweets = JSON.parse(execSync('cat ai/mock_tweets.json').toString());
        const questionsJson = execSync(`python ai/question_generator.py '${JSON.stringify(tweets)}'`).toString();
        const questions = JSON.parse(questionsJson);

        if (questions.length !== 15) {
            return res.status(500).json({ error: 'Failed to generate 15 questions' });
        }

        const ipfsCid = await uploadToIPFS(questions);

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const gameResult = await client.query(
                'INSERT INTO games (creator_basename, stake_amount, player_limit, duration, ipfs_cid) VALUES ($1, $2, $3, $4, $5) RETURNING id',
                [basename, stakeAmount, playerLimit, duration, ipfsCid]
            );
            const gameId = gameResult.rows[0].id;

            for (let stage = 1; stage <= 3; stage++) {
                for (let i = 0; i < 5; i++) {
                    const q = questions[(stage - 1) * 5 + i];
                    await client.query(
                        'INSERT INTO questions (game_id, stage, question, options, correct_answer, hash, ipfs_cid) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                        [gameId, stage, q.question, JSON.stringify(q.options), q.correct_answer, q.hash, ipfsCid]
                    );
                }
            }

            await client.query('COMMIT');
            res.json({ gameId, questionHashes: questions.map(q => q.hash), ipfsCid });
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/games/:gameId/submit', async (req, res) => {
    try {
        await rateLimiter.consume(req.ip);
        const { gameId } = req.params;
        const { stage, answerHashes } = req.body;

        const result = await pool.query(
            'SELECT hash, correct_answer FROM questions WHERE game_id = $1 AND stage = $2',
            [gameId, stage]
        );

        let score = 0;
        for (let i = 0; i < result.rows.length; i++) {
            if (answerHashes[i] === result.rows[i].hash) {
                score++;
            }
        }

        res.json({ score });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(3000, () => {
    console.log('Server running on port 3000');
});