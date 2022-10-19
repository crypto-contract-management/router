import { ethers, upgrades } from "hardhat";
import hre from "hardhat";
import { CCMRouter, CCMRouter__factory, TestContract, TestContract__factory } from "../typechain-types";

async function main() {
  // CCM router
  if(hre.network.name == "bsc_testnet") {
     // Activate new proxy contract
     const proxyAddress = "0xc91E04F530d0d8e07cC4FfdbEDbDC40683BEbca6";
     const routerFactory = await ethers.getContractFactory("CCMRouterV2");
     await upgrades.upgradeProxy(proxyAddress, routerFactory, {kind: "uups"}) as CCMRouter;
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
