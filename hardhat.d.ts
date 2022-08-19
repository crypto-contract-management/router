/* Autogenerated file. Do not edit manually. */
/* tslint:disable */
/* eslint-disable */

import { ethers } from "ethers";
import {
  FactoryOptions,
  HardhatEthersHelpers as HardhatEthersHelpersBase,
} from "@nomiclabs/hardhat-ethers/types";

import * as Contracts from ".";

declare module "hardhat/types/runtime" {
  interface HardhatEthersHelpers extends HardhatEthersHelpersBase {
    getContractFactory(
      name: "ERC20",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.ERC20__factory>;
    getContractFactory(
      name: "IERC20Metadata",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.IERC20Metadata__factory>;
    getContractFactory(
      name: "IERC20",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.IERC20__factory>;
    getContractFactory(
      name: "Lock",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.Lock__factory>;
    getContractFactory(
      name: "ITcpFactory",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.ITcpFactory__factory>;
    getContractFactory(
      name: "TcpFactory",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.TcpFactory__factory>;
    getContractFactory(
      name: "IERC20",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.IERC20__factory>;
    getContractFactory(
      name: "IPancakeCallee",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.IPancakeCallee__factory>;
    getContractFactory(
      name: "IPancakeERC20",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.IPancakeERC20__factory>;
    getContractFactory(
      name: "ITcpPair",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.ITcpPair__factory>;
    getContractFactory(
      name: "PancakeERC20",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.PancakeERC20__factory>;
    getContractFactory(
      name: "TaxPair",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.TaxPair__factory>;
    getContractFactory(
      name: "TcpPair",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.TcpPair__factory>;
    getContractFactory(
      name: "TestContract",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.TestContract__factory>;
    getContractFactory(
      name: "WBNB",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.WBNB__factory>;
    getContractFactory(
      name: "PancakeRouterV2",
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<Contracts.PancakeRouterV2__factory>;

    getContractAt(
      name: "ERC20",
      address: string,
      signer?: ethers.Signer
    ): Promise<Contracts.ERC20>;
    getContractAt(
      name: "IERC20Metadata",
      address: string,
      signer?: ethers.Signer
    ): Promise<Contracts.IERC20Metadata>;
    getContractAt(
      name: "IERC20",
      address: string,
      signer?: ethers.Signer
    ): Promise<Contracts.IERC20>;
    getContractAt(
      name: "Lock",
      address: string,
      signer?: ethers.Signer
    ): Promise<Contracts.Lock>;
    getContractAt(
      name: "ITcpFactory",
      address: string,
      signer?: ethers.Signer
    ): Promise<Contracts.ITcpFactory>;
    getContractAt(
      name: "TcpFactory",
      address: string,
      signer?: ethers.Signer
    ): Promise<Contracts.TcpFactory>;
    getContractAt(
      name: "IERC20",
      address: string,
      signer?: ethers.Signer
    ): Promise<Contracts.IERC20>;
    getContractAt(
      name: "IPancakeCallee",
      address: string,
      signer?: ethers.Signer
    ): Promise<Contracts.IPancakeCallee>;
    getContractAt(
      name: "IPancakeERC20",
      address: string,
      signer?: ethers.Signer
    ): Promise<Contracts.IPancakeERC20>;
    getContractAt(
      name: "ITcpPair",
      address: string,
      signer?: ethers.Signer
    ): Promise<Contracts.ITcpPair>;
    getContractAt(
      name: "PancakeERC20",
      address: string,
      signer?: ethers.Signer
    ): Promise<Contracts.PancakeERC20>;
    getContractAt(
      name: "TaxPair",
      address: string,
      signer?: ethers.Signer
    ): Promise<Contracts.TaxPair>;
    getContractAt(
      name: "TcpPair",
      address: string,
      signer?: ethers.Signer
    ): Promise<Contracts.TcpPair>;
    getContractAt(
      name: "TestContract",
      address: string,
      signer?: ethers.Signer
    ): Promise<Contracts.TestContract>;
    getContractAt(
      name: "WBNB",
      address: string,
      signer?: ethers.Signer
    ): Promise<Contracts.WBNB>;
    getContractAt(
      name: "PancakeRouterV2",
      address: string,
      signer?: ethers.Signer
    ): Promise<Contracts.PancakeRouterV2>;

    // default types
    getContractFactory(
      name: string,
      signerOrOptions?: ethers.Signer | FactoryOptions
    ): Promise<ethers.ContractFactory>;
    getContractFactory(
      abi: any[],
      bytecode: ethers.utils.BytesLike,
      signer?: ethers.Signer
    ): Promise<ethers.ContractFactory>;
    getContractAt(
      nameOrAbi: string | any[],
      address: string,
      signer?: ethers.Signer
    ): Promise<ethers.Contract>;
  }
}