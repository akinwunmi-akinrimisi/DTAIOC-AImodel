DTriviaAIOnChain
A Web3 trivia DApp generating 15 questions from X tweets using AI.
Backend

URL: https://dtaioc-aimodel-1.onrender.com
API Docs: https://dtaioc-aimodel-1.onrender.com/api-docs (Swagger UI)

Features

Fetches 6 tweets via X API (free tier, 100 requests/24h).
Falls back to ai/user1.json (@TheObiLeonard), ai/user2.json (@oxygist), or ai/user3.json (@bigwizarrdd) on rate limit.
Generates 15 questions with OpenAI (gpt-4o-mini), prefixed with “According to @’s tweets”.
Stores OAuth tokens in users table with 24h+ validity via refresh tokens.
Stores games/questions in PostgreSQL (Render).
Questions pinned to IPFS via Pinata.

Setup

X API: Register at https://developer.x.com, set X_CLIENT_ID, X_CLIENT_SECRET, X_REDIRECT_URI.
Callback URI: https://dtaioc-aimodel-1.onrender.com/auth/callback
Database: Run python database/init_db.py.
Environment: Set OPENAI_API_KEY, PINATA_JWT, DB_* in config/.env.
Endpoints:
GET /health: Check server status.
GET /auth/login: Initiate X OAuth.
GET /auth/callback: Handle OAuth callback.
POST /games: Create trivia game.
POST /games/:gameId/submit: Submit answers.
GET /games/:gameId/questions: Retrieve questions.
See https://dtaioc-aimodel-1.onrender.com/api-docs for details.



Notes

Questions reflect tweet content, not verified truths.
OAuth tokens persist in database, refreshed automatically for 24h+ access.
Cron job: curl https://dtaioc-aimodel-1.onrender.com every 5 minutes.

