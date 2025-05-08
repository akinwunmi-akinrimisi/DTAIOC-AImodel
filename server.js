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
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const { ethers } = require('ethers');

const execPromise = util.promisify(exec);

const app = express();
app.use(express.json());
app.use(cors());

// Swagger configuration
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'DTriviaAIOnChain API',
      version: '1.0.0',
      description: 'API for a Web3 trivia DApp generating questions from X tweets',
    },
    servers: [
      {
        url: 'https://dtaioc-aimodel-1.onrender.com',
        description: 'Production server',
      },
    ],
  },
  apis: ['./server.js'],
};
const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

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

// Web3 configuration
const provider = new ethers.providers.JsonRpcProvider(`https://eth-sepolia.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`);
const contractAddress = process.env.CONTRACT_ADDRESS || '0xYourContractAddress';
const paymasterAddress = process.env.PAYMASTER_ADDRESS || '0xYourPaymasterAddress';
const entryPointAddress = process.env.ENTRY_POINT_ADDRESS || '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';
const contractAbi = [
  {
    "inputs": [
      {"internalType": "address", "name": "to", "type": "address"},
      {"internalType": "uint256", "name": "amount", "type": "uint256"}
    ],
    "name": "mint",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
];
const contract = new ethers.Contract(contractAddress, contractAbi, provider);

// Store OAuth state
const oauthStates = new Map();

// Refresh token function
async function refreshUserToken(username, refreshToken) {
  try {
    console.error(`Refreshing token for ${username}`);
    const { client, accessToken, refreshToken: newRefreshToken } = await twitterClient.refreshOAuth2Token(refreshToken);
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000); // Assume 2-hour validity
    await pool.query(
      'INSERT INTO users (username, access_token, refresh_token, expires_at) VALUES ($1, $2, $3, $4) ON CONFLICT (username) DO UPDATE SET access_token = $2, refresh_token = $3, expires_at = $4, updated_at = CURRENT_TIMESTAMP',
      [username, accessToken, newRefreshToken, expiresAt]
    );
    console.error(`Token refreshed for ${username}`);
    return accessToken;
  } catch (error) {
    console.error(`Error refreshing token for ${username}:`, error.message);
    throw error;
  }
}

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Check server health
 *     description: Returns the status of environment variables and server health
 *     responses:
 *       200:
 *         description: Server health status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: ok
 *                 env:
 *                   type: object
 *                   properties:
 *                     X_CLIENT_ID:
 *                       type: boolean
 *                     X_CLIENT_SECRET:
 *                       type: boolean
 *                     X_REDIRECT_URI:
 *                       type: string
 *                     DB_NAME:
 *                       type: boolean
 *                     PINATA_JWT:
 *                       type: boolean
 *                     OPENAI_API_KEY:
 *                       type: boolean
 */
app.get('/health', (req, res) => {
  const envStatus = {
    X_CLIENT_ID: !!process.env.X_CLIENT_ID,
    X_CLIENT_SECRET: !!process.env.X_CLIENT_SECRET,
    X_REDIRECT_URI: process.env.X_REDIRECT_URI,
    DB_NAME: !!process.env.DB_NAME,
    PINATA_JWT: !!process.env.PINATA_JWT,
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    ALCHEMY_API_KEY: !!process.env.ALCHEMY_API_KEY,
    CONTRACT_ADDRESS: !!process.env.CONTRACT_ADDRESS
  };
  res.json({ status: 'ok', env: envStatus });
});

/**
 * @swagger
 * /auth/login:
 *   get:
 *     summary: Initiate X OAuth 2.0 login
 *     description: Redirects to X OAuth for user authentication
 *     parameters:
 *       - in: query
 *         name: username
 *         schema:
 *           type: string
 *         required: true
 *         description: X username
 *     responses:
 *       302:
 *         description: Redirects to X OAuth URL
 *       400:
 *         description: Username is required
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Username is required
 *       500:
 *         description: Failed to initiate OAuth login
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                 details:
 *                   type: string
 */
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

/**
 * @swagger
 * /auth/callback:
 *   get:
 *     summary: Handle X OAuth 2.0 callback
 *     description: Exchanges OAuth code for access token and stores it
 *     parameters:
 *       - in: query
 *         name: state
 *         schema:
 *           type: string
 *         required: true
 *         description: OAuth state
 *       - in: query
 *         name: code
 *         schema:
 *           type: string
 *         required: true
 *         description: OAuth authorization code
 *     responses:
 *       200:
 *         description: Successful authentication
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Successfully authenticated for <username>
 *       400:
 *         description: Invalid or expired state
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Invalid or expired state
 *       500:
 *         description: Failed to authenticate with X
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                 details:
 *                   type: string
 */
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

    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000); // Assume 2-hour validity
    await pool.query(
      'INSERT INTO users (username, access_token, refresh_token, expires_at) VALUES ($1, $2, $3, $4) ON CONFLICT (username) DO UPDATE SET access_token = $2, refresh_token = $3, expires_at = $4, updated_at = CURRENT_TIMESTAMP',
      [username, accessToken, refreshToken, expiresAt]
    );

    console.error(`Successfully authenticated ${username}`);
    res.json({ message: `Successfully authenticated for ${username}` });
  } catch (error) {
    console.error('OAuth callback error:', error.message, error.stack);
    res.status(500).json({ error: 'Failed to authenticate with X', details: error.message });
  }
});

/**
 * @swagger
 * /games:
 *   post:
 *     summary: Create a new trivia game
 *     description: Fetches user tweets, generates trivia questions, and stores game data
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               basename:
 *                 type: string
 *                 description: Base name for the game
 *                 example: creator.base.eth
 *               stakeAmount:
 *                 type: integer
 *                 description: Stake amount for the game
 *                 example: 10
 *               playerLimit:
 *                 type: integer
 *                 description: Maximum number of players
 *                 example: 50
 *               duration:
 *                 type: integer
 *                 description: Game duration in seconds
 *                 example: 3600
 *               username:
 *                 type: string
 *                 description: X username for tweet fetching
 *                 example: akinwunmi_eth
 *             required:
 *               - basename
 *               - stakeAmount
 *               - playerLimit
 *               - duration
 *               - username
 *     responses:
 *       200:
 *         description: Game created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 gameId:
 *                   type: integer
 *                   example: 1
 *                 questionHashes:
 *                   type: array
 *                   items:
 *                     type: string
 *                     example: 0x...
 *                 ipfsCid:
 *                   type: string
 *                   example: Qm...
 *       400:
 *         description: Username is required
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Username is required
 *       401:
 *         description: User not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: User not authenticated. Please authenticate via /auth/login
 *       500:
 *         description: Failed to create game
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                 stderr:
 *                   type: string
 *                 stdout:
 *                   type: string
 */
app.post('/games', async (req, res) => {
  const { basename, stakeAmount, playerLimit, duration, username } = req.body;

  if (!username) {
    console.error('Games endpoint error: Username is required');
    return res.status(400).json({ error: 'Username is required' });
  }

  let accessToken;
  try {
    console.error(`Checking token for ${username}`);
    const userResult = await pool.query(
      'SELECT access_token, refresh_token, expires_at FROM users WHERE username = $1',
      [username]
    );

    if (userResult.rows.length === 0) {
      console.error(`Games endpoint error: User ${username} not authenticated`);
      return res.status(401).json({ error: 'User not authenticated. Please authenticate via /auth/login' });
    }

    const { access_token, refresh_token, expires_at } = userResult.rows[0];
    if (new Date() > expires_at) {
      console.error(`Token expired for ${username}`);
      accessToken = await refreshUserToken(username, refresh_token);
    } else {
      accessToken = access_token;
    }
  } catch (error) {
    console.error(`Error checking token for ${username}:`, error.message);
    return res.status(500).json({ error: `Failed to verify authentication: ${error.message}` });
  }

  let tempFilePath = '/tmp/tweets.json';
  let tweets;

  try {
    const userClient = new TwitterApi(accessToken);

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
    const createdAt = new Date();
    const endTime = new Date(createdAt.getTime() + duration * 1000);
    const gameResult = await pool.query(
      'INSERT INTO games (basename, stake_amount, player_limit, duration, status, end_time) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [basename, stakeAmount, playerLimit, duration, 'active', endTime]
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

/**
 * @swagger
 * /games/{gameId}/join:
 *   post:
 *     summary: Join an existing trivia game
 *     description: Allows an authenticated user to join a game, enforcing player limit
 *     parameters:
 *       - in: path
 *         name: gameId
 *         schema:
 *           type: integer
 *         required: true
 *         description: ID of the game
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username:
 *                 type: string
 *                 description: X username of the user joining
 *                 example: akinwunmi_eth
 *             required:
 *               - username
 *     responses:
 *       200:
 *         description: Successfully joined the game
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Successfully joined game 1
 *       400:
 *         description: Invalid request (e.g., username missing, game not found)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Username is required
 *       401:
 *         description: User not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: User not authenticated. Please authenticate via /auth/login
 *       403:
 *         description: Game is full or already joined
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Game has reached player limit
 *       500:
 *         description: Failed to join game
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 */
app.post('/games/:gameId/join', async (req, res) => {
  const { gameId } = req.params;
  const { username } = req.body;

  if (!username) {
    console.error('Join endpoint error: Username is required');
    return res.status(400).json({ error: 'Username is required' });
  }

  try {
    // Check if user is authenticated
    const userResult = await pool.query(
      'SELECT username FROM users WHERE username = $1',
      [username]
    );
    if (userResult.rows.length === 0) {
      console.error(`Join endpoint error: User ${username} not authenticated`);
      return res.status(401).json({ error: 'User not authenticated. Please authenticate via /auth/login' });
    }

    // Check if game exists and is active
    const gameResult = await pool.query(
      'SELECT player_limit, end_time FROM games WHERE id = $1 AND status = $2',
      [gameId, 'active']
    );
    if (gameResult.rows.length === 0) {
      console.error(`Join endpoint error: Game ${gameId} not found or not active`);
      return res.status(400).json({ error: 'Game not found or not active' });
    }

    const { player_limit, end_time } = gameResult.rows[0];
    if (new Date() > new Date(end_time)) {
      console.error(`Join endpoint error: Game ${gameId} has ended`);
      return res.status(400).json({ error: 'Game has ended' });
    }

    // Check player limit
    const participantResult = await pool.query(
      'SELECT COUNT(*) as count FROM game_participants WHERE game_id = $1',
      [gameId]
    );
    const participantCount = parseInt(participantResult.rows[0].count);
    if (participantCount >= player_limit) {
      console.error(`Join endpoint error: Game ${gameId} has reached player limit`);
      return res.status(403).json({ error: 'Game has reached player limit' });
    }

    // Check if user already joined
    const alreadyJoined = await pool.query(
      'SELECT 1 FROM game_participants WHERE game_id = $1 AND username = $2',
      [gameId, username]
    );
    if (alreadyJoined.rows.length > 0) {
      console.error(`Join endpoint error: User ${username} already joined game ${gameId}`);
      return res.status(403).json({ error: 'User already joined this game' });
    }

    // Add user to game_participants
    await pool.query(
      'INSERT INTO game_participants (game_id, username) VALUES ($1, $2)',
      [gameId, username]
    );

    console.error(`User ${username} successfully joined game ${gameId}`);
    res.json({ message: `Successfully joined game ${gameId}` });
  } catch (error) {
    console.error('Error in /join endpoint:', error.message, error.stack);
    res.status(500).json({ error: `Failed to join game: ${error.message}` });
  }
});

/**
 * @swagger
 * /games/{gameId}/submit:
 *   post:
 *     summary: Submit answers for a game
 *     description: Submits answer hashes and calculates score for an authenticated user
 *     parameters:
 *       - in: path
 *         name: gameId
 *         schema:
 *           type: integer
 *         required: true
 *         description: ID of the game
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username:
 *                 type: string
 *                 description: X username of the submitting user
 *                 example: akinwunmi_eth
 *               stage:
 *                 type: integer
 *                 description: Game stage
 *                 example: 1
 *               answerHashes:
 *                 type: array
 *                 items:
 *                   type: string
 *                   example: 0x...
 *                 description: Array of answer hashes
 *             required:
 *               - username
 *               - stage
 *               - answerHashes
 *     responses:
 *       200:
 *         description: Submission successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 score:
 *                   type: integer
 *                   example: 1
 *       400:
 *         description: Invalid request (e.g., username missing)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Username is required
 *       401:
 *         description: User not authenticated or not joined
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: User has not joined this game
 *       500:
 *         description: Failed to submit answers
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 */
app.post('/games/:gameId/submit', async (req, res) => {
  const { gameId } = req.params;
  const { username, stage, answerHashes } = req.body;

  if (!username) {
    console.error('Submit endpoint error: Username is required');
    return res.status(400).json({ error: 'Username is required' });
  }

  try {
    // Check if user is authenticated
    const userResult = await pool.query(
      'SELECT username FROM users WHERE username = $1',
      [username]
    );
    if (userResult.rows.length === 0) {
      console.error(`Submit endpoint error: User ${username} not authenticated`);
      return res.status(401).json({ error: 'User not authenticated. Please authenticate via /auth/login' });
    }

    // Check if user has joined the game
    const joinedResult = await pool.query(
      'SELECT 1 FROM game_participants WHERE game_id = $1 AND username = $2',
      [gameId, username]
    );
    if (joinedResult.rows.length === 0) {
      console.error(`Submit endpoint error: User ${username} has not joined game ${gameId}`);
      return res.status(401).json({ error: 'User has not joined this game' });
    }

    // Check if game exists and is active
    const gameResult = await pool.query(
      'SELECT end_time FROM games WHERE id = $1 AND status = $2',
      [gameId, 'active']
    );
    if (gameResult.rows.length === 0) {
      console.error(`Submit endpoint error: Game ${gameId} not found or not active`);
      return res.status(400).json({ error: 'Game not found or not active' });
    }

    const { end_time } = gameResult.rows[0];
    if (new Date() > new Date(end_time)) {
      console.error(`Submit endpoint error: Game ${gameId} has ended`);
      return res.status(400).json({ error: 'Game has ended' });
    }

    // Fetch questions and calculate score
    console.error('Fetching questions for gameId:', gameId);
    const questionsResult = await pool.query('SELECT hash, correct_answer FROM questions WHERE game_id = $1', [gameId]);
    const correctHashes = questionsResult.rows.map(q => q.hash);

    let score = 0;
    for (let i = 0; i < answerHashes.length; i++) {
      if (answerHashes[i] === correctHashes[i]) {
        score += 1;
      }
    }

    // Insert submission
    console.error('Inserting submission for gameId:', gameId);
    await pool.query(
      'INSERT INTO submissions (game_id, username, stage, score, answer_hashes) VALUES ($1, $2, $3, $4, $5)',
      [gameId, username, stage, score, answerHashes]
    );

    res.json({ score });
  } catch (error) {
    console.error('Error in /submit endpoint:', error.message, error.stack);
    res.status(500).json({ error: `Failed to submit answers: ${error.message}` });
  }
});

/**
 * @swagger
 * /games/{gameId}/questions:
 *   get:
 *     summary: Retrieve questions for a game
 *     description: Returns all questions for the specified game
 *     parameters:
 *       - in: path
 *         name: gameId
 *         schema:
 *           type: integer
 *         required: true
 *         description: ID of the game
 *     responses:
 *       200:
 *         description: List of questions
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   question:
 *                     type: string
 *                     example: According to akinwunmi_eth's tweets, which version of Uniswap...
 *                   options:
 *                     type: array
 *                     items:
 *                       type: string
 *                       example: V3
 *                   hash:
 *                     type: string
 *                     example: 0x...
 *       500:
 *         description: Failed to fetch questions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 */
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

/**
 * @swagger
 * /games/{gameId}/leaderboard:
 *   get:
 *     summary: Retrieve leaderboard for a game
 *     description: Returns ranked list of players with their highest scores
 *     parameters:
 *       - in: path
 *         name: gameId
 *         schema:
 *           type: integer
 *         required: true
 *         description: ID of the game
 *     responses:
 *       200:
 *         description: Leaderboard data
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   username:
 *                     type: string
 *                     example: akinwunmi_eth
 *                   score:
 *                     type: integer
 *                     example: 15
 *       400:
 *         description: Game not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Game not found
 *       500:
 *         description: Failed to fetch leaderboard
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 */
app.get('/games/:gameId/leaderboard', async (req, res) => {
  const { gameId } = req.params;

  try {
    // Check if game exists
    const gameResult = await pool.query(
      'SELECT 1 FROM games WHERE id = $1',
      [gameId]
    );
    if (gameResult.rows.length === 0) {
      console.error(`Leaderboard endpoint error: Game ${gameId} not found`);
      return res.status(400).json({ error: 'Game not found' });
    }

    // Fetch leaderboard (max score per user)
    const leaderboardResult = await pool.query(
      'SELECT username, MAX(score) as score FROM submissions WHERE game_id = $1 GROUP BY username ORDER BY score DESC',
      [gameId]
    );

    res.json(leaderboardResult.rows);
  } catch (error) {
    console.error('Error in /leaderboard endpoint:', error.message, error.stack);
    res.status(500).json({ error: `Failed to fetch leaderboard: ${error.message}` });
  }
});

/**
 * @swagger
 * /games/{gameId}/mint:
 *   post:
 *     summary: Mint tokens for a game winner
 *     description: Triggers token minting for an authenticated user, using a paymaster for gasless transactions
 *     parameters:
 *       - in: path
 *         name: gameId
 *         schema:
 *           type: integer
 *         required: true
 *         description: ID of the game
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username:
 *                 type: string
 *                 description: X username of the user minting tokens
 *                 example: akinwunmi_eth
 *               amount:
 *                 type: integer
 *                 description: Amount of tokens to mint
 *                 example: 100
 *             required:
 *               - username
 *               - amount
 *     responses:
 *       200:
 *         description: Tokens minted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 transactionHash:
 *                   type: string
 *                   example: 0x...
 *       400:
 *         description: Invalid request (e.g., username missing, game not ended)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Username is required
 *       401:
 *         description: User not authenticated or not a winner
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: User is not eligible to mint tokens
 *       500:
 *         description: Failed to mint tokens
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 */
app.post('/games/:gameId/mint', async (req, res) => {
  const { gameId } = req.params;
  const { username, amount } = req.body;

  if (!username || !amount) {
    console.error('Mint endpoint error: Username and amount are required');
    return res.status(400).json({ error: 'Username and amount are required' });
  }

  try {
    // Check if user is authenticated and has wallet address
    const userResult = await pool.query(
      'SELECT wallet_address FROM users WHERE username = $1',
      [username]
    );
    if (userResult.rows.length === 0 || !userResult.rows[0].wallet_address) {
      console.error(`Mint endpoint error: User ${username} not authenticated or no wallet address`);
      return res.status(401).json({ error: 'User not authenticated or no wallet address set. Please authenticate via /auth/login and set wallet address' });
    }
    const walletAddress = userResult.rows[0].wallet_address;

    // Check if game exists and has ended
    const gameResult = await pool.query(
      'SELECT end_time FROM games WHERE id = $1',
      [gameId]
    );
    if (gameResult.rows.length === 0) {
      console.error(`Mint endpoint error: Game ${gameId} not found`);
      return res.status(400).json({ error: 'Game not found' });
    }
    const { end_time } = gameResult.rows[0];
    if (new Date() < new Date(end_time)) {
      console.error(`Mint endpoint error: Game ${gameId} has not ended`);
      return res.status(400).json({ error: 'Game has not ended' });
    }

    // Check if user is in top leaderboard (e.g., top 3)
    const leaderboardResult = await pool.query(
      'SELECT username FROM (SELECT username, MAX(score) as score FROM submissions WHERE game_id = $1 GROUP BY username ORDER BY score DESC LIMIT 3) as top WHERE username = $2',
      [gameId, username]
    );
    if (leaderboardResult.rows.length === 0) {
      console.error(`Mint endpoint error: User ${username} is not eligible to mint`);
      return res.status(401).json({ error: 'User is not eligible to mint tokens' });
    }

    // Construct UserOperation for gasless transaction (simplified, assumes EIP-4337 setup)
    const userOp = {
      sender: walletAddress,
      nonce: await provider.getTransactionCount(walletAddress),
      initCode: '0x',
      callData: contract.interface.encodeFunctionData('mint', [walletAddress, ethers.utils.parseUnits(amount.toString(), 18)]),
      callGasLimit: ethers.utils.hexlify(200000),
      verificationGasLimit: ethers.utils.hexlify(100000),
      preVerificationGas: ethers.utils.hexlify(21000),
      maxFeePerGas: ethers.utils.hexlify(1000000000),
      maxPriorityFeePerGas: ethers.utils.hexlify(1000000000),
      paymasterAndData: paymasterAddress + '0x', // Simplified, assumes paymaster accepts
      signature: '0x' // Dummy signature, assumes paymaster handles validation
    };

    // Submit UserOperation to EntryPoint (mocked, replace with actual bundler call)
    console.error(`Submitting UserOperation for ${username} to mint ${amount} tokens`);
    // const tx = await provider.send('eth_sendUserOperation', [userOp, entryPointAddress]);
    // For demo, simulate transaction
    const tx = { hash: '0xMockTransactionHash' };

    console.error(`Tokens minted for ${username}, tx: ${tx.hash}`);
    res.json({ transactionHash: tx.hash });
  } catch (error) {
    console.error('Error in /mint endpoint:', error.message, error.stack);
    res.status(500).json({ error: `Failed to mint tokens: ${error.message}` });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});