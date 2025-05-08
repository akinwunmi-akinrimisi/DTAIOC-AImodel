require('dotenv').config();
const express = require('express');
const { exec } = require('child_process');
const util = require('util');
const PinataClient = require('@pinata/sdk');
const { Pool } = require('pg');
const cors = require('cors');
const { TwitterApi } = require('twitter-api-v2');
const fs = require('fs');
const path = require('path');

const execPromise = util.promisify(exec);

const app = express();
app.use(express.json());
app.use(cors());

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

// Twitter API configuration
if (!process.env.X_CLIENT_ID || !process.env.X_CLIENT_SECRET) {
  console.error('Error: X_CLIENT_ID or X_CLIENT_SECRET is not set');
}
const twitterClient = new TwitterApi({
  clientId: process.env.X_CLIENT_ID,
  clientSecret: process.env.X_CLIENT_SECRET,
});

// Store OAuth state and tokens
const oauthStates = new Map();
const userTokens = new Map();

// Health check endpoint
app.get('/health', (req, res) => {
  const envStatus = {
    X_CLIENT_ID: !!process.env.X_CLIENT_ID,
    X_CLIENT_SECRET: !!process.env.X_CLIENT_SECRET,
    X_REDIRECT_URI: process.env.X_REDIRECT_URI,
    DB_NAME: !!process.env.DB_NAME,
    PINATA_JWT: !!process.env.PINATA_JWT,
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY
  };
  res.json({ status: 'ok', env: envStatus });
});

// OAuth 2.0 login endpoint
app.get('/auth/login', (req, res) => {
  const { username } = req.query;
  if (!username) {
    console.error('OAuth login error: Username is required');
    return res.status(400).json({ error: 'Username is required' });
  }

  try {
    const { url, codeVerifier, state } = twitterClient.generateOAuth2AuthLink(
      process.env.X_REDIRECT_URI,
      { scope: ['tweet.read', 'users.read', 'offline.access'] }
    );

    oauthStates.set(state, { username, codeVerifier });
    setTimeout(() => oauthStates.delete(state), 15 * 60 * 1000);

    console.error(`Redirecting ${username} to X OAuth URL`);
    res.redirect(url);
  } catch (error) {
    console.error('OAuth login error:', error.message, error.stack);
    res.status(500).json({ error: 'Failed to initiate OAuth login', details: error.message });
  }
});

// OAuth 2.0 callback endpoint
app.get('/auth/callback', async (req, res) => {
  const { state, code } = req.query;

  if (!oauthStates.has(state)) {
    console.error('OAuth callback error: Invalid or expired state');
    return res.status(400).json({ error: 'Invalid or expired state' });
  }

  const { username, codeVerifier } = oauthStates.get(state);
  oauthStates.delete(state);

  try {
    console.error(`Exchanging code for access token for ${username}`);
    const { client, accessToken, refreshToken } = await twitterClient.loginWithOAuth2({
      code,
      codeVerifier,
      redirectUri: process.env.X_REDIRECT_URI,
    });

    userTokens.set(username, { accessToken, refreshToken });
    setTimeout(() => userTokens.delete(username), 2 * 60 * 60 * 1000);

    console.error(`Successfully authenticated ${username}`);
    res.json({ message: `Successfully authenticated for ${username}` });
  } catch (error) {
    console.error('OAuth callback error:', error.message, error.stack);
    res.status(500).json({ error: 'Failed to authenticate with X', details: error.message });
  }
});

// Generate questions endpoint
app.post('/games', async (req, res) => {
  const { basename, stakeAmount, playerLimit, duration, username } = req.body;

  if (!username) {
    console.error('Games endpoint error: Username is required');
    return res.status(400).json({ error: 'Username is required' });
  }

  if (!userTokens.has(username)) {
    console.error(`Games endpoint error: User ${username} not authenticated`);
    return res.status(401).json({ error: 'User not authenticated. Please authenticate via /auth/login' });
  }

  let tempFilePath = '/tmp/tweets.json';
  let tweets;

  try {
    const userClient = new TwitterApi(userTokens.get(username).accessToken);

    console.error(`Fetching user ID for username: ${username}`);
    const userResponse = await userClient.v2.userByUsername(username);
    const userId = userResponse.data.id;

    if (!userId) {
      throw new Error(`User ID not found for username: ${username}`);
    }

    console.error(`Fetching up to 6 tweets for user ID: ${userId}`);
    const tweetsResponse = await userClient.v2.userTimeline(userId, {
      max_results: 6
    }).catch(error => {
      if (error.data && error.data.status === 429) {
        throw error; // Handle rate limit specifically below
      }
      throw error;
    });

    console.error(`Rate limit remaining: ${tweetsResponse.headers && tweetsResponse.headers['x-rate-limit-remaining'] || 'Unknown'}`);
    console.error(`Rate limit reset: ${tweetsResponse.headers && tweetsResponse.headers['x-rate-limit-reset'] ? new Date(parseInt(tweetsResponse.headers['x-rate-limit-reset']) * 1000).toISOString() : 'Unknown'}`);

    tweets = [];
    for await (const tweet of tweetsResponse) {
      tweets.push({
        text: tweet.text,
        created_at: tweet.created_at,
      });
    }

    console.error(`Fetched ${tweets.length} tweets`);

    if (tweets.length === 0) {
      throw new Error('No tweets found for the user');
    }

    console.error(`Writing tweets to ${tempFilePath}`);
    fs.writeFileSync(tempFilePath, JSON.stringify({ username, tweets }));
  } catch (error) {
    if (error.data && error.data.status === 429) {
      console.error('Rate limit exceeded, falling back to backup tweet files');
      const backupFiles = [
        path.join(__dirname, 'ai/user1.json'),
        path.join(__dirname, 'ai/user2.json'),
        path.join(__dirname, 'ai/user3.json')
      ];
      tempFilePath = backupFiles[Math.floor(Math.random() * backupFiles.length)];
      console.error(`Using backup file: ${tempFilePath}`);
      try {
        const backupData = JSON.parse(fs.readFileSync(tempFilePath));
        if (!backupData.username || !Array.isArray(backupData.tweets)) {
          throw new Error('Invalid backup file format');
        }
        console.error(`Backup file loaded: ${backupData.username}, ${backupData.tweets.length} tweets`);
      } catch (backupError) {
        console.error('Error reading backup file:', backupError.message);
        return res.status(500).json({
          error: `Failed to create game: Rate limit exceeded and backup file error: ${backupError.message}`
        });
      }
    } else {
      console.error('Error in tweet fetch:', error.message, error.stack);
      return res.status(500).json({
        error: `Failed to create game: ${error.message}`,
        stderr: error.stderr || '',
        stdout: error.stdout || ''
      });
    }
  }

  try {
    console.error('Executing question_generator.py with file:', tempFilePath);
    const { stdout, stderr } = await execPromise(`python ai/question_generator.py ${tempFilePath}`);
    if (stderr) {
      console.error('Question generator stderr:', stderr);
    }
    console.error('Question generator stdout:', stdout);

    const questions = JSON.parse(stdout);
    if (!Array.isArray(questions) || questions.length === 0) {
      throw new Error('No questions generated');
    }

    const questionHashes = questions.map(q => q.hash);

    console.error('Inserting game into database');
    const gameResult = await pool.query(
      'INSERT INTO games (basename, stake_amount, player_limit, duration, status) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [basename, stakeAmount, playerLimit, duration, 'active']
    );
    const gameId = gameResult.rows[0].id;

    console.error('Inserting questions into database');
    for (const q of questions) {
      await pool.query(
        'INSERT INTO questions (game_id, question_text, options, correct_answer, hash) VALUES ($1, $2, $3, $4, $5)',
        [gameId, q.question, q.options, q.correct_answer, q.hash]
      );
    }

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
    console.error('Error in /games endpoint:', error.message, error.stack);
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
    console.error('Fetching questions for gameId:', gameId);
    const questionsResult = await pool.query('SELECT hash, correct_answer FROM questions WHERE game_id = $1', [gameId]);
    const correctHashes = questionsResult.rows.map(q => q.hash);

    let score = 0;
    for (let i = 0; i < answerHashes.length; i++) {
      if (answerHashes[i] === correctHashes[i]) {
        score += 1;
      }
    }

    console.error('Inserting submission for gameId:', gameId);
    await pool.query(
      'INSERT INTO submissions (game_id, stage, score, answer_hashes) VALUES ($1, $2, $3, $4)',
      [gameId, stage, score, answerHashes]
    );

    res.json({ score });
  } catch (error) {
    console.error('Error in /submit endpoint:', error.message, error.stack);
    res.status(500).json({ error: `Failed to submit answers: ${error.message}` });
  }
});

// Get questions endpoint
app.get('/games/:gameId/questions', async (req, res) => {
  const { gameId } = req.params;
  try {
    console.error('Fetching questions for gameId:', gameId);
    const questionsResult = await pool.query(
      'SELECT question_text AS question, options, hash FROM questions WHERE game_id = $1',
      [gameId]
    );
    res.json(questionsResult.rows);
  } catch (error) {
    console.error('Error in /questions endpoint:', error.message, error.stack);
    res.status(500).json({ error: `Failed to fetch questions: ${error.message}` });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});