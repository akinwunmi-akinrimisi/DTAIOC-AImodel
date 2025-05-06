import tweepy
from dotenv import load_dotenv
import os
from datetime import datetime, timedelta

load_dotenv()

class TwitterFetcher:
    def __init__(self):
        self.client = tweepy.Client(
            bearer_token=os.getenv("TWITTER_BEARER_TOKEN"),
            consumer_key=os.getenv("TWITTER_API_KEY"),
            consumer_secret=os.getenv("TWITTER_API_SECRET"),
            access_token=os.getenv("TWITTER_ACCESS_TOKEN"),
            access_token_secret=os.getenv("TWITTER_ACCESS_TOKEN_SECRET")
        )

    def fetch_tweets(self, username, max_tweets=100):
        try:
            # Get user ID from username
            user = self.client.get_user(username=username)
            if not user.data:
                print(f"User {username} not found")
                return []

            # Fetch tweets (up to 100, within 1 year)
            tweets = self.client.get_users_tweets(
                id=user.data.id,
                max_results=max_tweets,
                tweet_fields=["created_at", "text"],
                end_time=datetime.now() - timedelta(days=365)
            )
            if not tweets.data:
                print(f"No tweets found for {username}")
                return []

            # Return list of tweets with text and timestamp
            return [
                {"text": tweet.text, "created_at": tweet.created_at.isoformat()}
                for tweet in tweets.data
            ]
        except Exception as e:
            print(f"Error fetching tweets: {e}")
            return []