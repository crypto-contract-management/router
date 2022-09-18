// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "hardhat/console.sol";
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

contract TCSTackingSellTax is ERC20, ITaxToken {

    mapping(address => uint8) private isPair;
    mapping(address => uint8) public isExcluded;

    uint public sellCounter;

    address public owner;

    constructor(address _router) ERC20("TestContract", "TC") {
        owner = msg.sender;
        _mint(msg.sender, 1_000_000 * 10**18);
        isExcluded[msg.sender] = 1;
        isExcluded[_router] = 1;
    }

    function setIsPair(address pair, uint8 _isPair) public {
        isPair[pair] = _isPair;
    }

    event TokenTransfer(address, address, uint256);
    function _beforeTokenTransfer(address from, address to, uint256 amount)
        internal virtual override // Add virtual here!
    {
        // If a pair is part of a token transfer the sender or taget has to be the router.
        // That ensures we're always able to take fees on the router.
        if(isExcluded[from] == 0 && isExcluded[to] == 0){
            require(isPair[from] == 0 && isPair[to] == 0, "TCP: Router required");
        }
        emit TokenTransfer(from, to, amount);
    }


    function onTaxClaimed(address taxableToken, uint amount) external {

    }

    function takeTax(
        address taxableToken, address from, 
        bool isBuy, uint amount
    ) external returns(uint taxToTake, bool claimAfter){
        // We take sell fees for continuous sells.
        // Increase sell fee by 10% each time someone sells.
        // Reset on buy.
        uint feesToTake = amount * sellCounter * 10 / 100;
        if(isBuy){
            sellCounter = 0;
        } else {
            sellCounter += 1;
        }
        return (feesToTake, false);
    } 

    fallback() external payable { }
    receive() external payable { }
}