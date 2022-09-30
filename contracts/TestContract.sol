// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "hardhat/console.sol";
import "./ITaxToken.sol";
import "./TCBaseContract.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract TestContract is TCBaseContract {

    constructor(address _router) TCBaseContract(_router) { }

}