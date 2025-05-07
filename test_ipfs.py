import os
import requests
import json
from dotenv import load_dotenv

load_dotenv('config/.env')

api_key = os.getenv('PINATA_API_KEY')

if not api_key:
    print("Error: PINATA_API_KEY not set")
    exit(1)

url = "https://api.pinata.cloud/pinning/pinJSONToIPFS"
data = {"test": "Hello, Pinata IPFS!"}
headers = {
    'Authorization': f'Bearer {api_key}',
    'Content-Type': 'application/json'
}

try:
    response = requests.post(url, json=data, headers=headers)
    print(f"Status Code: {response.status_code}")
    print(f"Response: {response.text}")
    response_json = response.json()
    print(f"CID: {response_json['IpfsHash']}")
except Exception as e:
    print(f"Error: {e}")