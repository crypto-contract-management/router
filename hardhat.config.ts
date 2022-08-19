import '@typechain/hardhat';
import '@openzeppelin/hardhat-upgrades';
import "hardhat-gas-reporter";
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.9",
    settings: {
      optimizer: {
        enabled: true,
        runs: 1000,
      },
    },
  },
  gasReporter: {
    enabled: true
  },
  networks: {
    hardhat: {
      allowUnlimitedContractSize: true
    },
    bsc_testnet: {
        url: "https://data-seed-prebsc-1-s1.binance.org:8545/",
        chainId: 97,
        accounts: process.env.DEPLOYER_PRIVATE_KEY
            ? [process.env.DEPLOYER_PRIVATE_KEY as string]
            : undefined,
    },
    bsc_mainnet: {
        url: "https://bsc-dataseed.binance.org/",
        chainId: 56,
        accounts: process.env.DEPLOYER_PRIVATE_KEY
            ? [process.env.DEPLOYER_PRIVATE_KEY as string]
            : undefined,
    },
  },
  paths: {
      sources: 'contracts'
  },
  typechain: {
    externalArtifacts: ['abis/*.json']
  },
};

export default config;