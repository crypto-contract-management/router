import { ethers, upgrades } from "hardhat";
import hre from "hardhat";
import { CCMRouter, CCMRouter__factory, CryptoContractManagement, TestContract, TestContract__factory } from "../typechain-types";

async function main() {
  // CCM router
  if(hre.network.name == "bsc_testnet") {
     // Activate new proxy contract
     const proxyAddress = "0x54575E5c09014Fc790382961BB026C9bad907Ca2";
     const routerFactory = await ethers.getContractFactory("CryptoContractManagement");
     await upgrades.upgradeProxy(proxyAddress, routerFactory, {kind: "uups"}) as CryptoContractManagement;
  }
  else {
      console.error("Inavlid Network");
      process.exit(1);
  }
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
