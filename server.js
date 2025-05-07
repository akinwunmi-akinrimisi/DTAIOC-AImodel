const express = require('express');
const { execSync } = require('child_process');
const { Pool } = require('pg');
const pinataSDK = require('@pinata/sdk');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables
dotenv.config();

const app = express();
app.use(express.json({ strict: true }));

// Database configuration
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

// Pinata configuration
const pinata = new pinataSDK(process.env.PINATA_API_KEY);

// Endpoint to create a new game
app.post('/games', async (req, res) => {
  const { basename, stakeAmount, playerLimit, duration } = req.body;

  try {
    // Validate input
    if (!basename || !stakeAmount || !playerLimit || !duration) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Generate questions using Python script
    let questions;
    try {
      const tweets = [
        { text: 'Just attended the AI Summit 2025 in San Francisco! #AI #Tech', created_at: '2025-04-15T10:30:00.000Z' },
        { text: 'Excited to watch the SpaceX Starship launch tomorrow! 🚀 @SpaceX', created_at: '2025-04-20T14:45:00.000Z' },
        // Add more tweets as needed
      ];
      // Escape single quotes in JSON string
      const tweetJson = JSON.stringify(tweets).replace(/'/g, "'\\''");
      const command = `python ai/question_generator.py '${tweetJson}'`;
      console.log(`Executing command: ${command}`);
      const output = execSync(command, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      console.log(`Python script output: ${output}`);
      questions = JSON.parse(output);
    } catch (error) {
      console.error(`Python script error: ${error.message}`);
      console.error(`stderr: ${error.stderr || 'No stderr'}`);
      console.error(`stdout: ${error.stdout || 'No stdout'}`);
      return res.status(500).json({
        error: `Question generator failed: ${error.message}`,
        stderr: error.stderr || 'No stderr',
        stdout: error.stdout || 'No stdout',
      });
    }

    // Validate questions
    if (!Array.isArray(questions) || questions.length !== 15) {
      return res.status(500).json({ error: 'Invalid question format or count' });
    }

    // Upload questions to Pinata
    let ipfsCid;
    try {
      const pinataResponse = await pinata.pinJSONToIPFS(questions);
      ipfsCid = pinataResponse.IpfsHash;
    } catch (error) {
      console.error(`Pinata error: ${error.message}`);
      return res.status(500).json({ error: `Pinata upload failed: ${error.message}` });
    }

    // Store game in database
    try {
      const query = `
        INSERT INTO games (basename, stake_amount, player_limit, duration, ipfs_cid, question_hashes)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
      `;
      const questionHashes = questions.map(q => q.hash);
      const values = [basename, stakeAmount, playerLimit, duration, ipfsCid, questionHashes];
      const result = await pool.query(query, values);
      const gameId = result.rows[0].id;

      return res.json({ gameId, questionHashes, ipfsCid });
    } catch (error) {
      console.error(`Database error: ${error.message}`);
      return res.status(500).json({ error: `Database error: ${error.message}` });
    }
  } catch (error) {
    console.error(`Unexpected error: ${error.message}`);
    return res.status(500).json({ error: `Unexpected error: ${error.message}` });
  }
});

// Endpoint to submit answers
app.post('/games/:gameId/submit', async (req, res) => {
  const { gameId } = req.params;
  const { stage, answerHashes } = req.body;

  try {
    // Fetch game data
    const gameQuery = 'SELECT question_hashes FROM games WHERE id = $1';
    const gameResult = await pool.query(gameQuery, [gameId]);
    if (gameResult.rows.length === 0) {
      return res.status(404).json({ error: 'Game not found' });
    }

    // Call answer validator
    try {
      const command = `python ai/answer_validator.py '${JSON.stringify({ gameId, stage, answerHashes })}'`;
      const output = execSync(command, { encoding: 'utf8' });
      const score = JSON.parse(output).score;
      return res.json({ score });
    } catch (error) {
      console.error(`Answer validator error: ${error.message}`);
      return res.status(500).json({ error: `Answer validator failed: ${error.message}` });
    }
  } catch (error) {
    console.error(`Unexpected error: ${error.message}`);
    return res.status(500).json({ error: `Unexpected error: ${error.message}` });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});