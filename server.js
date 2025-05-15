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
const { ethers } = require('ethers');
const { BiconomySmartAccountV2 } = require('@biconomy/account');

const execPromise = util.promisify(exec);

const app = express();
app.use(express.json());
app.use(cors());

// Swagger configuration
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(JSON.parse(fs.readFileSync(path.join(__dirname, 'openapi.json'), 'utf8'))));
app.get('/api-docs', (req, res) => res.redirect('/api-docs/'));

// Database configuration with SSL
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false }
});

// Initialize database schema
async function initializeDatabase() {
  try {
    console.log('Running database initialization script');
    const { stdout, stderr } = await execPromise('python database/init_db.py');
    console.log('Database init stdout:', stdout);
    if (stderr) console.error('Database init stderr:', stderr);
  } catch (error) {
    console.error('Error running init_db.py:', error.message);
  }
}
initializeDatabase();

// Verify database connection
async function verifyDatabaseConnection() {
  try {
    const client = await pool.connect();
    console.log('Database connection successful');
    console.log('DB Config:', {
      user: process.env.DB_USER,
      host: process.env.DB_HOST,
      database: process.env.DB_NAME,
      port: process.env.DB_PORT
    });
    const res = await client.query('SELECT NOW()');
    console.log('Database time:', res.rows[0].now);
    client.release();
  } catch (error) {
    console.error('Database connection error:', error.message);
  }
}
verifyDatabaseConnection();

// Pinata configuration
const pinataJwt = process.env.PINATA_JWT;
console.log('Checking PINATA_JWT:', pinataJwt ? 'Set' : 'Not set');
let pinata;
try {
  if (!pinataJwt) throw new Error('PINATA_JWT environment variable is not set');
  pinata = new PinataClient({ pinataJWTKey: pinataJwt });
  console.log('Pinata client initialized successfully');
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
const providerUrl = `https://base-sepolia.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
console.log('Initializing provider with URL:', providerUrl.replace(process.env.ALCHEMY_API_KEY, '[REDACTED]'));
const provider = new ethers.providers.JsonRpcProvider(providerUrl);
provider.on('error', (error) => {
  console.error('Provider error:', error.message);
});
const contracts = {
  DTAIOCToken: '0xB0f1D7Cf1821557271C01F2e560d3B397Fe9ed3c',
  DTAIOCNFT: '0xFCadE10a83E0963C31e8F9EB1712AE4AeC422FD1',
  DTAIOCStaking: '0xf5d48836E1FDf267294Ca6B1B6f3860c18eF75dC',
  IBasenameResolver: '0xE2d6C0aF79bf5CA534B591B5A86bd467B308aB8F',
  DTAIOCGame: '0xA6d6A60eaA5F52b60843deFFF560F788E7C44d78',
};
const entryPointAddress = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';
const paymasterAddress = '0xB2314387E65847eaA006c850376298abd7e0BcAe';
const abis = {};
const contractInstances = {};
for (const [name, address] of Object.entries(contracts)) {
  try {
    const abiPath = path.join(__dirname, 'abis', `${name}.json`);
    if (!fs.existsSync(abiPath)) {
      console.error(`ABI file for ${name} not found at ${abiPath}`);
      continue;
    }
    const abiData = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
    abis[name] = Array.isArray(abiData) ? abiData : abiData.abi;
    if (!Array.isArray(abis[name])) {
      console.error(`Invalid ABI format for ${name}: expected array`);
      continue;
    }
    contractInstances[name] = new ethers.Contract(address, abis[name], provider);
  } catch (error) {
    console.error(`Error loading ABI for ${name}: ${error.message}`);
  }
}

// Store OAuth state
const oauthStates = new Map();

// Refresh token function
async function refreshUserToken(username, refreshToken) {
  try {
    console.log(`Refreshing token for ${username}`);
    const { client, accessToken, refreshToken: newRefreshToken } = await twitterClient.refreshOAuth2Token(refreshToken);
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    await pool.query(
      'INSERT INTO users (username, access_token, refresh_token, expires_at) VALUES ($1, $2, $3, $4) ON CONFLICT (username) DO UPDATE SET access_token = $2, refresh_token = $3, expires_at = $4, updated_at = CURRENT_TIMESTAMP',
      [username, accessToken, newRefreshToken, expiresAt]
    );
    console.log(`Token refreshed for ${username}`);
    return accessToken;
  } catch (error) {
    console.error(`Error refreshing token for ${username}:`, error.message);
    throw error;
  }
}

// Health endpoint
app.get('/health', (req, res) => {
  const envStatus = {
    X_CLIENT_ID: !!process.env.X_CLIENT_ID,
    X_CLIENT_SECRET: !!process.env.X_CLIENT_SECRET,
    X_REDIRECT_URI: !!process.env.X_REDIRECT_URI,
    DB_NAME: !!process.env.DB_NAME,
    PINATA_JWT: !!process.env.PINATA_JWT,
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    ALCHEMY_API_KEY: !!process.env.ALCHEMY_API_KEY,
    BUNDLER_URL: !!process.env.BUNDLER_URL,
    SIGNER_PRIVATE_KEY: !!process.env.SIGNER_PRIVATE_KEY,
    BICONOMY_PAYMASTER_API_KEY: !!process.env.BICONOMY_PAYMASTER_API_KEY,
  };
  res.json({ status: 'ok', env: envStatus });
});

// Auth endpoints
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
    console.log(`Redirecting ${username} to X OAuth URL`);
    res.redirect(url);
  } catch (error) {
    console.error('OAuth login error:', error.message, error.stack);
    res.status(500).json({ error: 'Failed to initiate OAuth login', details: error.message });
  }
});

app.get('/auth/callback', async (req, res) => {
  const { state, code } = req.query;
  if (!oauthStates.has(state)) {
    console.error('OAuth callback error: Invalid or expired state');
    return res.status(400).json({ error: 'Invalid or expired state' });
  }
  const { username, codeVerifier } = oauthStates.get(state);
  oauthStates.delete(state);
  try {
    console.log(`Exchanging code for access token for ${username}`);
    const { client, accessToken, refreshToken } = await twitterClient.loginWithOAuth2({
      code,
      codeVerifier,
      redirectUri: process.env.X_REDIRECT_URI,
    });
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    await pool.query(
      'INSERT INTO users (username, access_token, refresh_token, expires_at) VALUES ($1, $2, $3, $4) ON CONFLICT (username) DO UPDATE SET access_token = $2, refresh_token = $3, expires_at = $4, updated_at = CURRENT_TIMESTAMP',
      [username, accessToken, refreshToken, expiresAt]
    );
    console.log(`Successfully authenticated ${username}`);
    res.json({ message: `Successfully authenticated for ${username}` });
  } catch (error) {
    console.error('OAuth callback error:', error.message, error.stack);
    res.status(500).json({ error: 'Failed to authenticate with X', details: error.message });
  }
});

// Game endpoints
app.post('/games', async (req, res) => {
  const { basename, stakeAmount, playerLimit, duration, username } = req.body;
  if (!username) {
    console.error('Games endpoint error: Username is required');
    return res.status(400).json({ error: 'Username is required' });
  }
  let accessToken;
  try {
    console.log(`Checking token for ${username}`);
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
      console.log(`Token expired for ${username}`);
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
    console.log(`Fetching user ID for username: ${username}`);
    const userResponse = await userClient.v2.userByUsername(username);
    const userId = userResponse.data.id;
    if (!userId) throw new Error(`User ID not found for username: ${username}`);
    console.log(`Fetching up to 6 tweets for user ID: ${userId}`);
    const tweetsResponse = await userClient.v2.userTimeline(userId, { max_results: 6 }).catch(error => {
      if (error.data && error.data.status === 429) throw error;
      throw error;
    });
    console.log(`Rate limit remaining: ${tweetsResponse.headers?.['x-rate-limit-remaining'] || 'Unknown'}`);
    console.log(`Rate limit reset: ${tweetsResponse.headers?.['x-rate-limit-reset'] ? new Date(parseInt(tweetsResponse.headers['x-rate-limit-reset']) * 1000).toISOString() : 'Unknown'}`);
    tweets = [];
    for await (const tweet of tweetsResponse) {
      tweets.push({ text: tweet.text, created_at: tweet.created_at });
    }
    console.log(`Fetched ${tweets.length} tweets`);
    if (tweets.length === 0) throw new Error('No tweets found for the user');
    console.log(`Writing tweets to ${tempFilePath}`);
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
      console.log(`Using backup file: ${tempFilePath}`);
      try {
        const backupData = JSON.parse(fs.readFileSync(tempFilePath));
        if (!backupData.username || !Array.isArray(backupData.tweets)) throw new Error('Invalid backup file format');
        console.log(`Backup file loaded: ${backupData.username}, ${backupData.tweets.length} tweets`);
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
    console.log('Executing question_generator.py with file:', tempFilePath);
    const { stdout, stderr } = await execPromise(`python ai/question_generator.py ${tempFilePath}`);
    if (stderr) console.error('Question generator stderr:', stderr);
    console.log('Question generator stdout:', stdout);
    const questions = JSON.parse(stdout);
    if (!Array.isArray(questions) || questions.length === 0) throw new Error('No questions generated');
    const questionHashes = questions.map(q => q.hash);
    console.log('Inserting game into database');
    const createdAt = new Date();
    const endTime = new Date(createdAt.getTime() + duration * 1000);
    console.log(`Game creation: createdAt=${createdAt.toISOString()}, duration=${duration}, endTime=${endTime.toISOString()}`);
    const gameResult = await pool.query(
      'INSERT INTO games (basename, stake_amount, player_limit, duration, status, end_time, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [basename, stakeAmount, playerLimit, duration, 'active', endTime, createdAt]
    );
    const gameId = gameResult.rows[0].id;
    console.log('Inserting questions into database');
    for (const q of questions) {
      await pool.query(
        'INSERT INTO questions (game_id, question_text, options, correct_answer, hash) VALUES ($1, $2, $3, $4, $5)',
        [gameId, q.question, q.options, q.correct_answer, q.hash]
      );
    }
    if (!pinata) throw new Error('Pinata client not initialized');
    console.log('Uploading questions to Pinata');
    const pinataResult = await pinata.pinJSONToIPFS({ questions });
    console.log('Pinata upload successful, CID:', pinataResult.IpfsHash);
    res.json({ gameId, questionHashes, ipfsCid: pinataResult.IpfsHash });
  } catch (error) {
    console.error('Error in /games endpoint:', error.message, error.stack);
    res.status(500).json({
      error: `Failed to create game: ${error.message}`,
      stderr: error.stderr || '',
      stdout: error.stdout || ''
    });
  }
});

app.post('/games/:gameId/join', async (req, res) => {
  const { gameId } = req.params;
  const { username } = req.body;
  if (!username) {
    console.error('Join endpoint error: Username is required');
    return res.status(400).json({ error: 'Username is required' });
  }
  try {
    const userResult = await pool.query('SELECT username FROM users WHERE username = $1', [username]);
    if (userResult.rows.length === 0) {
      console.error(`Join endpoint error: User ${username} not authenticated`);
      return res.status(401).json({ error: 'User not authenticated. Please authenticate via /auth/login' });
    }
    const gameResult = await pool.query('SELECT player_limit, end_time FROM games WHERE id = $1 AND status = $2', [gameId, 'active']);
    if (gameResult.rows.length === 0) {
      console.error(`Join endpoint error: Game ${gameId} not found or not active`);
      return res.status(400).json({ error: 'Game not found or not active' });
    }
    const { player_limit, end_time } = gameResult.rows[0];
    if (new Date() > new Date(end_time)) {
      console.error(`Join endpoint error: Game ${gameId} has ended`);
      return res.status(400).json({ error: 'Game has ended' });
    }
    const participantResult = await pool.query('SELECT COUNT(*) as count FROM game_participants WHERE game_id = $1', [gameId]);
    const participantCount = parseInt(participantResult.rows[0].count);
    if (participantCount >= player_limit) {
      console.error(`Join endpoint error: Game ${gameId} has reached player limit`);
      return res.status(403).json({ error: 'Game has reached player limit' });
    }
    const alreadyJoined = await pool.query('SELECT 1 FROM game_participants WHERE game_id = $1 AND username = $2', [gameId, username]);
    if (alreadyJoined.rows.length > 0) {
      console.error(`Join endpoint error: User ${username} already joined game ${gameId}`);
      return res.status(403).json({ error: 'User already joined this game' });
    }
    await pool.query('INSERT INTO game_participants (game_id, username) VALUES ($1, $2)', [gameId, username]);
    console.log(`User ${username} successfully joined game ${gameId}`);
    res.json({ message: `Successfully joined game ${gameId}` });
  } catch (error) {
    console.error('Error in /join endpoint:', error.message, error.stack);
    res.status(500).json({ error: `Failed to join game: ${error.message}` });
  }
});

app.post('/games/:gameId/submit', async (req, res) => {
  const { gameId } = req.params;
  const { username, stage, answerHashes } = req.body;
  if (!username) {
    console.error('Submit endpoint error: Username is required');
    return res.status(400).json({ error: 'Username is required' });
  }
  try {
    const userResult = await pool.query('SELECT username FROM users WHERE username = $1', [username]);
    if (userResult.rows.length === 0) {
      console.error(`Submit endpoint error: User ${username} not authenticated`);
      return res.status(401).json({ error: 'User not authenticated. Please authenticate via /auth/login' });
    }
    const joinedResult = await pool.query('SELECT 1 FROM game_participants WHERE game_id = $1 AND username = $2', [gameId, username]);
    if (joinedResult.rows.length === 0) {
      console.error(`Submit endpoint error: User ${username} has not joined game ${gameId}`);
      return res.status(401).json({ error: 'User has not joined this game' });
    }
    const gameResult = await pool.query('SELECT end_time FROM games WHERE id = $1 AND status = $2', [gameId, 'active']);
    if (gameResult.rows.length === 0) {
      console.error(`Submit endpoint error: Game ${gameId} not found or not active`);
      return res.status(400).json({ error: 'Game not found or not active' });
    }
    const { end_time } = gameResult.rows[0];
    if (new Date() > new Date(end_time)) {
      console.error(`Submit endpoint error: Game ${gameId} has ended`);
      return res.status(400).json({ error: 'Game has ended' });
    }
    console.log('Fetching questions for gameId:', gameId);
    const questionsResult = await pool.query('SELECT hash, correct_answer FROM questions WHERE game_id = $1', [gameId]);
    const correctHashes = questionsResult.rows.map(q => q.hash);
    let score = 0;
    for (let i = 0; i < answerHashes.length; i++) {
      if (answerHashes[i] === correctHashes[i]) score += 1;
    }
    console.log('Inserting submission for gameId:', gameId);
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

app.get('/games/:gameId/questions', async (req, res) => {
  const { gameId } = req.params;
  try {
    console.log('Fetching questions for gameId:', gameId);
    const questionsResult = await pool.query('SELECT question_text AS question, options, hash FROM questions WHERE game_id = $1', [gameId]);
    res.json(questionsResult.rows);
  } catch (error) {
    console.error('Error in /questions endpoint:', error.message, error.stack);
    res.status(500).json({ error: `Failed to fetch questions: ${error.message}` });
  }
});

app.get('/games/:gameId/leaderboard', async (req, res) => {
  const { gameId } = req.params;
  try {
    const gameResult = await pool.query('SELECT 1 FROM games WHERE id = $1', [gameId]);
    if (gameResult.rows.length === 0) {
      console.error(`Leaderboard endpoint error: Game ${gameId} not found`);
      return res.status(400).json({ error: 'Game not found' });
    }
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

app.post('/games/:gameId/mint', async (req, res) => {
  const { gameId } = req.params;
  const { username, amount } = req.body;
  if (!username || !amount) {
    console.error('Mint endpoint error: Username and amount are required');
    return res.status(400).json({ error: 'Username and amount are required' });
  }
  try {
    // Validate environment variables
    if (!process.env.SIGNER_PRIVATE_KEY) {
      throw new Error('SIGNER_PRIVATE_KEY environment variable is not set');
    }
    if (!process.env.BICONOMY_PAYMASTER_API_KEY) {
      throw new Error('BICONOMY_PAYMASTER_API_KEY environment variable is not set');
    }
    if (!process.env.BUNDLER_URL) {
      throw new Error('BUNDLER_URL environment variable is not set');
    }

    // Validate user and wallet
    const userResult = await pool.query('SELECT wallet_address FROM users WHERE username = $1', [username]);
    if (userResult.rows.length === 0 || !userResult.rows[0].wallet_address) {
      console.error(`Mint endpoint error: User ${username} not authenticated or no wallet address`);
      return res.status(401).json({ error: 'User not authenticated or no wallet address set. Please authenticate via /auth/login and set wallet address' });
    }
    const walletAddress = userResult.rows[0].wallet_address;

    // Validate game
    const gameResult = await pool.query('SELECT end_time FROM games WHERE id = $1', [gameId]);
    if (gameResult.rows.length === 0) {
      console.error(`Mint endpoint error: Game ${gameId} not found`);
      return res.status(400).json({ error: 'Game not found' });
    }
    const { end_time } = gameResult.rows[0];
    if (new Date() < new Date(end_time)) {
      console.error(`Mint endpoint error: Game ${gameId} has not ended`);
      return res.status(400).json({ error: 'Game has not ended' });
    }

    // Validate leaderboard eligibility
    const leaderboardResult = await pool.query(
      'SELECT username FROM (SELECT username, MAX(score) as score FROM submissions WHERE game_id = $1 GROUP BY username ORDER BY score DESC LIMIT 3) as top WHERE username = $2',
      [gameId, username]
    );
    if (leaderboardResult.rows.length === 0) {
      console.error(`Mint endpoint error: User ${username} is not eligible to mint`);
      return res.status(401).json({ error: 'User is not eligible to mint tokens' });
    }

    // Validate token contract
    const tokenContract = contractInstances.DTAIOCToken;
    if (!tokenContract) {
      console.error('Mint endpoint error: DTAIOCToken contract not initialized');
      return res.status(500).json({ error: 'Token contract not initialized' });
    }

    // Check minting paused
    const isPaused = await tokenContract.mintingPaused();
    if (isPaused) {
      console.error('Mint endpoint error: Minting is paused');
      return res.status(400).json({ error: 'Minting is paused on the contract' });
    }

    // Check minimum balance requirement
    const minBalance = await tokenContract.MIN_BALANCE_FOR_MINT();
    const balance = await provider.getBalance(walletAddress);
    if (balance.lt(minBalance)) {
      console.error(`Mint endpoint error: Insufficient balance for ${username}`);
      return res.status(400).json({ error: `Insufficient balance: ${ethers.utils.formatEther(balance)} ETH, required: ${ethers.utils.formatEther(minBalance)} ETH` });
    }

    // Initialize signer
    const signer = new ethers.Wallet(process.env.SIGNER_PRIVATE_KEY, provider);
    console.log(`Signer initialized for address: ${await signer.getAddress()}`);

    // Initialize Biconomy Smart Account
    const biconomyConfig = {
      chainId: 84532, // Base Sepolia
      entryPointAddress,
      signer,
      bundlerUrl: process.env.BUNDLER_URL,
      paymasterUrl: `https://paymaster.biconomy.io/api/v1/84532/${process.env.BICONOMY_PAYMASTER_API_KEY}`,
    };
    const smartAccount = await BiconomySmartAccountV2.create({
      chainId: biconomyConfig.chainId,
      entryPointAddress: biconomyConfig.entryPointAddress,
      signer: biconomyConfig.signer,
      bundler: { url: biconomyConfig.bundlerUrl },
      paymaster: { paymasterUrl: biconomyConfig.paymasterUrl },
    });
    console.log(`Smart account initialized for address: ${await smartAccount.getAccountAddress()}`);

    // Prepare transaction
    const callData = tokenContract.interface.encodeFunctionData('mint', [
      ethers.utils.parseUnits(amount.toString(), 18)
    ]);
    const tx = {
      to: contracts.DTAIOCToken,
      data: callData,
    };

    // Send transaction with paymaster
    console.log(`Submitting transaction for ${username} to mint ${amount} tokens`);
    const userOpResponse = await smartAccount.sendTransaction(tx, {
      paymasterServiceData: { mode: 'SPONSORED' },
    });

    // Wait for transaction
    const receipt = await userOpResponse.wait();
    console.log(`Tokens minted for ${username}, tx: ${receipt.transactionHash}`);
    res.json({ transactionHash: receipt.transactionHash });
  } catch (error) {
    console.error('Error in /mint endpoint:', error.message, error.stack);
    res.status(500).json({ error: `Failed to mint tokens: ${error.message}` });
  }
});

app.post('/games/:gameId/mint-tokens', async (req, res) => {
  const { gameId } = req.params;
  console.log(`Redirecting /games/${gameId}/mint-tokens to /games/${gameId}/mint`);
  req.url = `/games/${gameId}/mint`;
  app._router.handle(req, res);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});