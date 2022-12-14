import '@typechain/hardhat';
import '@openzeppelin/hardhat-upgrades';
import "@nomiclabs/hardhat-etherscan";
import "hardhat-gas-reporter";
import "hardhat-contract-sizer";
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
dotenv.config();

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.9",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  gasReporter: {
    enabled: true,
    coinmarketcap: "f34c1bdd-9b6b-427a-ada4-09517ba1e365",
    token: "BNB",
    gasPriceApi: "https://api.bscscan.com/api?module=proxy&action=eth_gasPrice"
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
  etherscan: {
      apiKey: {
          bscTestnet: '4SM3MYR8D3PIFFA1I913FIUPK83S3BT7UJ',
          bsc: '4SM3MYR8D3PIFFA1I913FIUPK83S3BT7UJ'
      }
  },
  paths: {
      sources: 'contracts'
  },
  typechain: {
    externalArtifacts: ['abis/*.json']
  },
  contractSizer: {

  }
};

export default config;
