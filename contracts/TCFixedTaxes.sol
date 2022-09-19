// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "hardhat/console.sol";
import "./TCBaseContract.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// This interface should be implemented by any token contract
// that pairs to a taxable token (such as WETH etc.)
// It provides methods for tax communication between us (the router) and you (your contract).
// Basically just a bunch of callback methods.
interface ITaxToken {
    /// @notice Called after you claimed tokens (manually or automatically)
    /// @dev Keep logic small. Your users (eventually) pay the gas for it.
    /// @param taxableToken The token you've been sent (like WETH)
    /// @param amount The amount transferred
    function onTaxClaimed(address taxableToken, uint amount) external;
    /// @notice Called when someone takes out (sell) or puts in (buy) the taxable token.
    /// @notice We basically tell you the amount processed and ask you how many tokens
    /// @notice you want to take as fees. This gives you ULTIMATE control and flexibility.
    /// @notice You're welcome.
    /// @dev DEVs, please kiss (look up this abbreviation).
    /// @dev This function is called on every taxable transfer so logic should be as minimal as possible.
    /// @param taxableToken The taxable token (like WETH)
    /// @param from Who is selling or buying (allows wallet-specific taxes)
    /// @param isBuy True if `from` bought your token (they sold WETH for example). False if it is a sell.
    /// @param amount The amount bought or sold.
    /// @return taxToTake The tax we should take. Must be lower than or equal to `amount`.
    /// @return claimAfter Indicates whether to directly claim all taxes after processing this request. Tremendously helpful for stuff such as auto liquidity.
    function takeTax(address taxableToken, address from, bool isBuy, uint amount) external returns(uint taxToTake, bool claimAfter);
}

contract TCFixedTaxes is TCBaseContract {
    
    function takeTax(
        address taxableToken, address from, 
        bool isBuy, uint amount
    ) external virtual override returns(uint taxToTake, bool claimAfter){
        // 5% buy 15% sell fee. Owner is free.
        if(from == owner)
            return (0, false);
        
        uint taxToTakePercent = isBuy ? 5 : 15;
        uint tax = amount * taxToTakePercent / 100;
        
        return (tax, true);
    } 

}