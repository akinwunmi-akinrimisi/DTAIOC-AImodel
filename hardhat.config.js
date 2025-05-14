require("@nomicfoundation/hardhat-toolbox");
require("hardhat-abi-exporter");

module.exports = {
  solidity: "0.8.20",
  etherscan: {
    apiKey: {
      baseSepolia: process.env.BASESCAN_API_KEY,
    },
    customChains: [
      {
        network: "baseSepolia",
        chainId: 84532,
        urls: {
          apiURL: "https://api-sepolia.basescan.org/api",
          browserURL: "https://sepolia.basescan.org",
        },
      },
    ],
  },
  abiExporter: {
    path: "./abis",
    runOnCompile: true,
    clear: true,
    flat: true,
    only: [
      "DTAIOCToken",
      "DTAIOCNFT",
      "DTAIOCStaking",
      "DTAIOCGame",
      "IBasenameResolver",
      "PlatformAddress",
    ],
    rename: {
      DTAIOCToken: "DTAIOCToken",
      DTAIOCNFT: "DTAIOCNFT",
      DTAIOCStaking: "DTAIOCStaking",
      DTAIOCGame: "DTAIOCGame",
      IBasenameResolver: "IBasenameResolver",
      PlatformAddress: "PlatformAddress",
    },
    except: [],
    spacing: 2,
  },
  networks: {
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      accounts: [
        process.env.PRIVATE_KEY,
        process.env.PRIVATE_KEY1,
        process.env.PRIVATE_KEY2
      ].filter(Boolean),
      gasPrice: 1000000000, // 1 gwei
    }
  },
};