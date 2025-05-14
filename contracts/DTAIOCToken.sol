// SPDX-License-Identifier: MIT
   pragma solidity ^0.8.20;

   import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
   import "@openzeppelin/contracts/access/Ownable.sol";

   contract DTAIOCToken is ERC20, Ownable {
       uint256 public constant MAX_SUPPLY = 5_000_000 * 10**18;
       uint256 public constant MAX_MINT_PER_WALLET = 30 * 10**18;
       uint256 public constant MIN_BALANCE_FOR_MINT = 10 * 10**18;

       mapping(address => uint256) public mintedAmount;
       bool public mintingPaused;
       uint256 public totalMinted;

       constructor() ERC20("DTriviaAIOnChain Token", "DTAIOC") Ownable(msg.sender) {}

       modifier whenMintingNotPaused() {
           require(!mintingPaused, "Minting is paused");
           _;
       }

       function mint(uint256 amount) public whenMintingNotPaused {
           require(amount > 0, "Amount must be greater than 0");
           require(totalMinted + amount <= MAX_SUPPLY, "Exceeds max supply");
           require(mintedAmount[msg.sender] + amount <= MAX_MINT_PER_WALLET, "Exceeds max mint per wallet");
           require(balanceOf(msg.sender) < MIN_BALANCE_FOR_MINT, "Balance must be below 10 tokens");

           mintedAmount[msg.sender] += amount;
           totalMinted += amount;
           _mint(msg.sender, amount);
       }

       function pauseMinting() public onlyOwner {
           mintingPaused = true;
       }

       function unpauseMinting() public onlyOwner {
           mintingPaused = false;
       }
   }