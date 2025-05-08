# from fastapi import FastAPI
# from fastapi.middleware.cors import CORSMiddleware

# app = FastAPI()

# # Optional: Allow frontend (like React) to access
# app.add_middleware(
#     CORSMiddleware,
#     allow_origins=["https://v0-web3-game-ui-design.vercel.app/"],  # Replace with frontend URL in production
#     allow_credentials=True,
#     allow_methods=["*"],
#     allow_headers=["*"],
# )

# @app.get("/")
# def root():
#     return {"message": "FastAPI is working!"}

# @app.get("/ping")
# def ping():
#     return {"status": "ok"}
