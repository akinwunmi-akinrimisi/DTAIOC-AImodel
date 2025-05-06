from dotenv import load_dotenv
import os

print(f"Current working directory: {os.getcwd()}")
env_path = os.path.join("config", ".env")
if not os.path.exists(env_path):
    print(f"Error: {env_path} does not exist")
else:
    print(f"Found {env_path}")

success = load_dotenv(os.path.join("config", ".env"))
print(f"load_dotenv success: {success}")
api_key = os.getenv("OPENAI_API_KEY")
print(f"OPENAI_API_KEY: {api_key}")

if api_key is None:
    print("All environment variables:")
    for key, value in os.environ.items():
        print(f"{key}: {value}")