// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "hardhat/console.sol";
import "./TCBaseContract.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract TCFixedTaxes is TCBaseContract {
    
    constructor(address _router) TCBaseContract(_router){ }

    function takeTax(
        address taxableToken, address from, 
        bool isBuy, uint amount
    ) external virtual override returns(uint taxToTake){
        // 5% buy 15% sell fee. Owner is free.
        if(from == owner)
            return 0;
        
        uint taxToTakePercent = isBuy ? 5 : 15;
        uint tax = amount * taxToTakePercent / 100;
        
        return tax;
    } 

}