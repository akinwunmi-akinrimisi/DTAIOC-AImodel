require('dotenv').config();
const express = require('express');
const { exec } = require('child_process');
const util = require('util');
const PinataClient = require('@pinata/sdk');
const { Pool } = require('pg');
const cors = require('cors');
const { TwitterApi } = require('twitter-api-v2');

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

// Store OAuth state and tokens temporarily (in-memory for simplicity; use Redis in production)
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
    // Generate OAuth 2.0 URL
    const { url, codeVerifier, state } = twitterClient.generateOAuth2AuthLink(
      process.env.X_REDIRECT_URI,
      { scope: ['tweet.read', 'users.read', 'offline.access'] }
    );

    // Store state and username
    oauthStates.set(state, { username, codeVerifier });
    setTimeout(() => oauthStates.delete(state), 15 * 60 * 1000); // Expire after 15 minutes

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
    // Exchange code for access token
    console.error(`Exchanging code for access token for ${username}`);
    const { client, accessToken, refreshToken } = await twitterClient.loginWithOAuth2({
      code,
      codeVerifier,
      redirectUri: process.env.X_REDIRECT_URI,
    });

    // Store tokens (in-memory for now)
    userTokens.set(username, { accessToken, refreshToken });
    setTimeout(() => userTokens.delete(username), 2 * 60 * 60 * 1000); // Expire after 2 hours

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

  try {
    // Create Twitter client with user's access token
    const userClient = new TwitterApi(userTokens.get(username).accessToken);

    // Get user ID
    console.error(`Fetching user ID for username: ${username}`);
    const userResponse = await userClient.v2.userByUsername(username);
    const userId = userResponse.data.id;

    // Fetch user's tweets (limited to 3 tweets)
    console.error(`Fetching up to 3 tweets for user ID: ${userId}`);
    const tweetsResponse = await userClient.v2.userTimeline(userId, {
      max_results: 3,
      'tweet.fields': ['created_at', 'text'],
    });

    const tweets = [];
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
    console.error('Error in /submit endpoint:', error.message, error.stack);
    res.status(500).json({ error: `Failed to submit answers: ${error.message}` });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});