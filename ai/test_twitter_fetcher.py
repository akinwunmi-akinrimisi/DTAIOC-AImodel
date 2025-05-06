from twitter_fetcher import TwitterFetcher

def test_fetch_tweets():
    fetcher = TwitterFetcher()
    tweets = fetcher.fetch_tweets("akinwunmi.eth")  # Replace with a public Twitter username
    print(f"Fetched {len(tweets)} tweets:")
    for tweet in tweets[:5]:  # Show first 5 tweets
        print(f"{tweet['created_at']}: {tweet['text']}")
    assert len(tweets) <= 100, "Fetched more than 100 tweets"

if __name__ == "__main__":
    test_fetch_tweets()