// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract DTAIOCNFT is ERC721URIStorage, Ownable {
    address public gameContract;
    uint256 private _tokenIdCounter;

    constructor() ERC721("DTriviaAIOnChain NFT", "DTAIOCNFT") Ownable(msg.sender) {
        _tokenIdCounter = 0;
    }

    modifier onlyGameContract() {
        require(msg.sender == gameContract, "Only game contract can call");
        _;
    }

    function setGameContract(address _gameContract) public onlyOwner {
        require(_gameContract != address(0), "Invalid game contract address");
        gameContract = _gameContract;
    }

    function mintNFT(address recipient, uint256 gameId, uint256 rank, string memory tokenURI)
        public
        onlyGameContract
        returns (uint256)
    {
        require(recipient != address(0), "Invalid recipient address");
        require(rank >= 1 && rank <= 3, "Invalid rank");
        require(bytes(tokenURI).length > 0, "Invalid token URI");

        _tokenIdCounter++;
        uint256 newTokenId = _tokenIdCounter;
        _mint(recipient, newTokenId);
        _setTokenURI(newTokenId, tokenURI);

        emit NFTMinted(newTokenId, recipient, gameId, rank, tokenURI);
        return newTokenId;
    }

    event NFTMinted(uint256 indexed tokenId, address indexed recipient, uint256 gameId, uint256 rank, string tokenURI);
}