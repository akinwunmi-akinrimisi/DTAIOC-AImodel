require('dotenv').config();
const express = require('express');
const { exec } = require('child_process');
const util = require('util');
const PinataClient = require('@pinata/sdk');
const { Pool } = require('pg');

const execPromise = util.promisify(exec);

const app = express();
app.use(express.json());

// Database configuration with SSL
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: {
    rejectUnauthorized: false
  }
});

// Initialize database schema
async function initializeDatabase() {
  try {
    console.error('Running database initialization script');
    const { stdout, stderr } = await execPromise('python database/init_db.py');
    console.error('Database init stdout:', stdout);
    if (stderr) {
      console.error('Database init stderr:', stderr);
    }
  } catch (error) {
    console.error('Error running init_db.py:', error.message);
  }
}
initializeDatabase();

// Verify database connection
async function verifyDatabaseConnection() {
  try {
    const client = await pool.connect();
    console.error('Database connection successful');
    console.error('DB Config:', {
      user: process.env.DB_USER,
      host: process.env.DB_HOST,
      database: process.env.DB_NAME,
      port: process.env.DB_PORT
    });
    const res = await client.query('SELECT NOW()');
    console.error('Database time:', res.rows[0].now);
    client.release();
  } catch (error) {
    console.error('Database connection error:', error.message);
  }
}
verifyDatabaseConnection();

// Pinata configuration
const pinataJwt = process.env.PINATA_JWT;
console.error('Checking PINATA_JWT:', pinataJwt ? 'Set' : 'Not set');
let pinata;
try {
  if (!pinataJwt) {
    throw new Error('PINATA_JWT environment variable is not set');
  }
  pinata = new PinataClient({ pinataJWTKey: pinataJwt });
  console.error('Pinata client initialized successfully');
} catch (error) {
  console.error('Error initializing Pinata client:', error.message);
}

// Generate questions endpoint
app.post('/games', async (req, res) => {
  const { basename, stakeAmount, playerLimit, duration } = req.body;

  try {
    // Fetch tweets (mocked for now)
    const tweets = [
      { text: 'Just attended the AI Summit 2025 in San Francisco! #AI #Tech', created_at: '2025-04-15T10:30:00.000Z' },
      { text: 'Excited to watch the SpaceX Starship launch tomorrow! 🚀 @SpaceX', created_at: '2025-04-20T14:45:00.000Z' }
    ];

    // Escape single quotes in JSON string
    const tweetsJson = JSON.stringify(tweets).replace(/'/g, "\\'");

    // Run question generator
    console.error('Executing question_generator.py with tweets:', tweetsJson);
    const { stdout, stderr } = await execPromise(`python ai/question_generator.py '${tweetsJson}'`);
    if (stderr) {
      console.error('Question generator stderr:', stderr);
    }
    console.error('Question generator stdout:', stdout);

    const questions = JSON.parse(stdout);
    if (!Array.isArray(questions) || questions.length === 0) {
      throw new Error('No questions generated');
    }

    // Extract question hashes
    const questionHashes = questions.map(q => q.hash);

    // Store game in database
    console.error('Inserting game into database');
    const gameResult = await pool.query(
      'INSERT INTO games (basename, stake_amount, player_limit, duration, status) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [basename, stakeAmount, playerLimit, duration, 'active']
    );
    const gameId = gameResult.rows[0].id;

    // Store questions in database
    console.error('Inserting questions into database');
    for (const q of questions) {
      await pool.query(
        'INSERT INTO questions (game_id, question_text, options, correct_answer, hash) VALUES ($1, $2, $3, $4, $5)',
        [gameId, q.question, q.options, q.correct_answer, q.hash]
      );
    }

    // Upload questions to Pinata
    if (!pinata) {
      throw new Error('Pinata client not initialized');
    }
    console.error('Uploading questions to Pinata');
    const pinataResult = await pinata.pinJSONToIPFS({ questions });
    console.error('Pinata upload successful, CID:', pinataResult.IpfsHash);

    res.json({
      gameId,
      questionHashes,
      ipfsCid: pinataResult.IpfsHash
    });
  } catch (error) {
    console.error('Error in /games endpoint:', error.message);
    res.status(500).json({
      error: `Failed to create game: ${error.message}`,
      stderr: error.stderr || '',
      stdout: error.stdout || ''
    });
  }
});

// Submit answers endpoint
app.post('/games/:gameId/submit', async (req, res) => {
  const { gameId } = req.params;
  const { stage, answerHashes } = req.body;

  try {
    // Fetch correct answers
    console.error('Fetching questions for gameId:', gameId);
    const questionsResult = await pool.query('SELECT hash, correct_answer FROM questions WHERE game_id = $1', [gameId]);
    const correctHashes = questionsResult.rows.map(q => q.hash);

    // Calculate score
    let score = 0;
    for (let i = 0; i < answerHashes.length; i++) {
      if (answerHashes[i] === correctHashes[i]) {
        score += 1;
      }
    }

    // Store submission
    console.error('Inserting submission for gameId:', gameId);
    await pool.query(
      'INSERT INTO submissions (game_id, stage, score, answer_hashes) VALUES ($1, $2, $3, $4)',
      [gameId, stage, score, answerHashes]
    );

    res.json({ score });
  } catch (error) {
    console.error('Error in /submit endpoint:', error.message);
    res.status(500).json({ error: `Failed to submit answers: ${error.message}` });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});