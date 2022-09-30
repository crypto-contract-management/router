// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "hardhat/console.sol";
import "./ITaxToken.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

abstract contract TCBaseContract is ERC20, Ownable, ITaxToken {

    mapping(address => bool) private isTaxablePair;
    mapping(address => bool) public isExcludedFromRouter;

    uint public sellCounter;

    constructor(address _router) ERC20("TestContract", "TC") {
        _mint(msg.sender, 1_000_000 * 10**18);
        isExcludedFromRouter[msg.sender] = true;
        isExcludedFromRouter[_router] = true;
    }

    function setIsTaxablePair(address pair, bool _isTaxablePair) public {
        isTaxablePair[pair] = _isTaxablePair;
    }

    event TokenTransfer(address, address, uint256);
    function _beforeTokenTransfer(address from, address to, uint256 amount)
        internal virtual override // Add virtual here!
    {
        // If a pair is part of a token transfer the sender or taget has to excluded.
        // That ensures we're always able to take fees on the router or let excluded
        // users choose a different router if they wish to do so.
        if(isTaxablePair[from] || isTaxablePair[to]){
            require(isExcludedFromRouter[from] || isExcludedFromRouter[to], "CCM: Router required");
        }
        emit TokenTransfer(from, to, amount);
    }


    function onTaxClaimed(address taxableToken, uint amount) external virtual {

    }

    function takeTax(
        address taxableToken, address from, 
        bool isBuy, uint amount
    ) external virtual returns(uint taxToTake){
        return 0;
    }

    function withdrawTax(address token, address to, uint amount) external virtual onlyOwner {

    }

    fallback() external payable { }
    receive() external payable { }
}