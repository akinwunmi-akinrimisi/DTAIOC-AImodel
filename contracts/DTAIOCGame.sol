// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "./DTAIOCToken.sol";
import "./DTAIOCNFT.sol";
import "./DTAIOCStaking.sol";
import "hardhat/console.sol";

interface IBasenameResolver {
    function namehash(bytes32 node) external pure returns (bytes32);
    function resolve(bytes32 node) external view returns (address);
}

contract DTAIOCGame is Ownable, ReentrancyGuard {
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public submitted;
    DTAIOCToken public token;
    DTAIOCNFT public nft;
    DTAIOCStaking public staking;
    IBasenameResolver public basenameResolver;
    address public backendSigner;
    address public platformAddress;
    uint256 public gameCounter;
    uint256 public constant STAKE_AMOUNT = 10 * 10**18;
    uint256 public constant PLAYER_LIMIT = 100;
    uint256 public constant DEFAULT_GAME_DURATION = 1 hours;
    string public constant NFT_TOKEN_URI = "ipfs://bafybeigofcndglhgthcq6qrmj3nuc3ahn7diovjxytuifk54t5svhufe4i";

    struct Player {
        string basename;
        uint256 currentStage;
        uint256 score;
        uint256 completionTime;
    }

    struct Game {
        address creator;
        bytes32 basenameNode;
        uint256 stage;
        uint256 startTime;
        uint256 gameDuration;
        mapping(address => Player) players;
        mapping(address => bool) participated;
        uint256 playerCount;
        bool ended;
        bytes32[3] questionRootHashes;
        address[] perfectScorers;
    }

    mapping(uint256 => Game) internal gamesData;
    mapping(uint256 => mapping(bytes32 => bool)) public questionHashUnique;

    constructor(
        address _token,
        address _nft,
        address _staking,
        address _basenameResolver,
        address _backendSigner,
        address _platformAddress
    ) Ownable(msg.sender) {
        require(_token != address(0), "Invalid token address");
        require(_nft != address(0), "Invalid NFT address");
        require(_staking != address(0), "Invalid staking address");
        require(_basenameResolver != address(0), "Invalid resolver address");
        require(_backendSigner != address(0), "Invalid backend signer address");
        require(_platformAddress != address(0), "Invalid platform address");
        token = DTAIOCToken(_token);
        nft = DTAIOCNFT(_nft);
        staking = DTAIOCStaking(_staking);
        basenameResolver = IBasenameResolver(_basenameResolver);
        backendSigner = _backendSigner;
        platformAddress = _platformAddress;
    }

    function games(uint256 gameId) external view returns (
        address creator,
        bytes32 basenameNode,
        uint256 stage,
        uint256 startTime,
        uint256 gameDuration,
        uint256 playerCount,
        bool ended,
        bytes32[3] memory questionRootHashes,
        address[] memory perfectScorers
    ) {
        Game storage game = gamesData[gameId];
        return (
            game.creator,
            game.basenameNode,
            game.stage,
            game.startTime,
            game.gameDuration,
            game.playerCount,
            game.ended,
            game.questionRootHashes,
            game.perfectScorers
        );
    }

    function createGame(bytes32 basenameNode, bytes32[3] memory questionRootHashes, uint256 _gameDuration)
        public
        nonReentrant
        returns (uint256)
    {
        address creator = basenameResolver.resolve(basenameNode);
        require(creator == msg.sender, "Caller does not own Basename");
        require(_gameDuration >= 1 hours && _gameDuration <= 24 hours, "Invalid game duration");
        for (uint256 i = 0; i < 3; i++) {
            require(questionRootHashes[i] != bytes32(0), "Invalid question hash");
            require(!questionHashUnique[gameCounter + 1][questionRootHashes[i]], "Duplicate question hash");
            questionHashUnique[gameCounter + 1][questionRootHashes[i]] = true;
        }

        gameCounter++;
        uint256 gameId = gameCounter;

        Game storage game = gamesData[gameId];
        game.creator = creator;
        game.basenameNode = basenameNode;
        game.stage = 1;
        game.startTime = block.timestamp;
        game.gameDuration = _gameDuration;
        game.playerCount = 0;
        game.ended = false;
        for (uint256 i = 0; i < 3; i++) {
            game.questionRootHashes[i] = questionRootHashes[i];
        }

        emit GameCreated(gameId, creator, basenameNode);
        return gameId;
    }

    function joinGame(uint256 gameId, string memory basename, bytes memory signature)
        public
        nonReentrant
    {
        Game storage game = gamesData[gameId];
        require(game.creator != address(0), "Game does not exist");
        require(!game.ended, "Game has ended");
        require(block.timestamp <= game.startTime + game.gameDuration, "Game duration exceeded");
        bytes32 gameSlot = keccak256(abi.encodePacked(gameId));
        bytes32 playerCountSlot = bytes32(uint256(gameSlot) + 14);
        bytes32 slotValue;
        assembly {
            slotValue := sload(playerCountSlot)
        }
        console.log("Raw playerCount slot value: %s", uint256(slotValue));
        console.log("Player count: %s, Limit: %s", game.playerCount, PLAYER_LIMIT);
        require(game.playerCount < PLAYER_LIMIT, "Player limit reached");
        require(!game.participated[msg.sender], "Player already joined");
        require(token.balanceOf(msg.sender) >= STAKE_AMOUNT, "Insufficient balance");
        require(token.allowance(msg.sender, address(staking)) >= STAKE_AMOUNT, "Insufficient allowance");

        bytes32 basenameNode = basenameResolver.namehash(keccak256(abi.encodePacked(basename)));
        require(basenameResolver.resolve(basenameNode) == msg.sender, "Basename does not resolve to caller");

        bytes32 messageHash = keccak256(abi.encode(msg.sender, basename, gameId));
        require(verify(backendSigner, messageHash, signature), "Invalid signature");

        game.participated[msg.sender] = true;
        game.players[msg.sender] = Player(basename, 1, 0, 0);
        game.playerCount++;

        staking.stake(gameId, msg.sender, STAKE_AMOUNT);

        emit PlayerJoined(gameId, msg.sender, basename);
    }

    function submitAnswers(
        uint256 gameId,
        uint256 stage,
        bytes32[] calldata answerHashes,
        uint256 score,
        bytes calldata signature
    ) external nonReentrant {
        Game storage game = gamesData[gameId];
        require(game.creator != address(0), "Game does not exist");
        require(!game.ended, "Game has ended");
        require(block.timestamp <= game.startTime + game.gameDuration, "Game duration exceeded");
        require(stage > 0 && stage <= game.questionRootHashes.length, "Invalid stage");
        require(stage == game.stage, "Stage not active");
        require(game.players[msg.sender].currentStage != 0, "Player eliminated");
        require(!submitted[gameId][stage][msg.sender], "Answers already submitted");
        require(game.players[msg.sender].currentStage == stage, "Player not in stage");
        require(answerHashes.length == 5, "Invalid number of answer hashes");
        require(score <= 5, "Invalid score");

        bytes32 messageHash = keccak256(abi.encode(gameId, msg.sender, stage, score, answerHashes));
        bytes32 ethSignedMessageHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        require(backendSigner == ECDSA.recover(ethSignedMessageHash, signature), "Invalid signature");

        submitted[gameId][stage][msg.sender] = true;
        Player storage player = game.players[msg.sender];
        player.score = score;

        if (score == 5) {
            player.currentStage = stage + 1;
            if (stage == game.questionRootHashes.length) {
                game.perfectScorers.push(msg.sender);
                player.completionTime = block.timestamp;
            }
            emit StageCompleted(gameId, msg.sender, stage, score, player.basename, player.completionTime);
        } else {
            game.playerCount--;
            staking.refund(gameId, msg.sender, game.stage);
            player.currentStage = 0;
            emit PlayerEliminated(gameId, msg.sender, stage, score, player.basename);
        }
    }

    function advanceStage(uint256 gameId) public onlyOwner {
        Game storage game = gamesData[gameId];
        require(game.creator != address(0), "Game does not exist");
        require(!game.ended, "Game has ended");
        require(game.stage < 4, "Game at final stage");
        game.stage++;
        emit StageAdvanced(gameId, game.stage);
    }

    function refundPlayer(uint256 gameId, address player) public onlyOwner {
        Game storage game = gamesData[gameId];
        require(game.creator != address(0), "Game does not exist");
        require(game.participated[player], "Player not in game");

        Player storage p = game.players[player];
        staking.refund(gameId, player, game.stage);
        emit PlayerEliminated(gameId, player, game.stage, 0, p.basename);
        delete game.players[player];
        game.participated[player] = false;
        game.playerCount--;
    }

    function endGame(uint256 gameId) public onlyOwner nonReentrant {
        Game storage game = gamesData[gameId];
        require(game.creator != address(0), "Game does not exist");
        require(!game.ended, "Game already ended");
        require(block.timestamp > game.startTime + game.gameDuration, "Game duration not reached");

        game.ended = true;

        address[] memory winnersArray = new address[](3);
        if (game.perfectScorers.length > 0) {
            address[] memory sortedScorers = new address[](game.perfectScorers.length);
            for (uint256 i = 0; i < game.perfectScorers.length; i++) {
                sortedScorers[i] = game.perfectScorers[i];
            }
            for (uint256 i = 0; i < sortedScorers.length; i++) {
                for (uint256 j = i + 1; j < sortedScorers.length; j++) {
                    if (
                        game.players[sortedScorers[j]].completionTime <
                        game.players[sortedScorers[i]].completionTime
                    ) {
                        address temp = sortedScorers[i];
                        sortedScorers[i] = sortedScorers[j];
                        sortedScorers[j] = temp;
                    }
                }
            }
            for (uint256 i = 0; i < 3 && i < sortedScorers.length; i++) {
                winnersArray[i] = sortedScorers[i];
            }
        }

        for (uint256 i = 0; i < 3; i++) {
            if (winnersArray[i] != address(0) && game.participated[winnersArray[i]]) {
                uint256 rank = i + 1;
                nft.mintNFT(winnersArray[i], gameId, rank, NFT_TOKEN_URI);
            }
        }

        if (staking.forfeitedStakes(gameId) > 0) {
            staking.distributeRewards(gameId, game.creator, platformAddress, winnersArray);
        }

        emit GameEnded(gameId, winnersArray);
    }

    function autoEndGame(uint256 gameId) external {
        Game storage game = gamesData[gameId];
        require(game.creator != address(0), "Game does not exist");
        require(!game.ended, "Game already ended");
        require(block.timestamp > game.startTime + game.gameDuration, "Game duration not reached");
        endGame(gameId);
    }

    function getLeaderboardData(uint256 gameId)
        public
        view
        returns (
            address[] memory playerAddresses,
            string[] memory basenames,
            uint256[] memory currentStages,
            uint256[] memory scores,
            uint256[] memory completionTimes
        )
    {
        Game storage game = gamesData[gameId];
        require(game.creator != address(0), "Game does not exist");

        uint256 activeCount = game.playerCount;
        playerAddresses = new address[](activeCount);
        basenames = new string[](activeCount);
        currentStages = new uint256[](activeCount);
        scores = new uint256[](activeCount);
        completionTimes = new uint256[](activeCount);

        uint256 index = 0;
        for (uint256 i = 0; i < 2**160 && index < activeCount; i++) {
            address playerAddr = address(uint160(i));
            if (game.participated[playerAddr]) {
                Player storage player = game.players[playerAddr];
                playerAddresses[index] = playerAddr;
                basenames[index] = player.basename;
                currentStages[index] = player.currentStage;
                scores[index] = player.score;
                completionTimes[index] = player.completionTime;
                index++;
            }
        }
        return (playerAddresses, basenames, currentStages, scores, completionTimes);
    }

    function isPlayerInGame(uint256 gameId, address player) public view returns (bool) {
        return gamesData[gameId].participated[player];
    }

    function getPlayer(uint256 gameId, address playerAddress) public view returns (
        string memory basename,
        uint256 currentStage,
        uint256 score,
        uint256 completionTime
    ) {
        Player storage player = gamesData[gameId].players[playerAddress];
        return (
            player.basename,
            player.currentStage,
            player.score,
            player.completionTime
        );
    }

    function setBackendSigner(address _backendSigner) public onlyOwner {
        require(_backendSigner != address(0), "Invalid backend signer address");
        backendSigner = _backendSigner;
    }

    function verify(address signer, bytes32 hash, bytes memory signature) public pure returns (bool) {
        bytes32 ethSignedMessageHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", hash)
        );
        (bytes32 r, bytes32 s, uint8 v) = splitSignature(signature);
        address recovered = ecrecover(ethSignedMessageHash, v, r, s);
        return recovered == signer;
    }

    function splitSignature(bytes memory sig) private pure returns (bytes32 r, bytes32 s, uint8 v) {
        require(sig.length == 65, "Invalid signature length");
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        return (r, s, v);
    }

    event GameCreated(uint256 indexed gameId, address indexed creator, bytes32 basenameNode);
    event PlayerJoined(uint256 indexed gameId, address indexed player, string basename);
    event StageAdvanced(uint256 indexed gameId, uint256 stage);
    event StageCompleted(
        uint256 indexed gameId,
        address indexed player,
        uint256 stage,
        uint256 score,
        string basename,
        uint256 completionTime
    );
    event PlayerEliminated(
        uint256 indexed gameId,
        address indexed player,
        uint256 stage,
        uint256 score,
        string basename
    );
    event GameEnded(uint256 indexed gameId, address[] winners);
}