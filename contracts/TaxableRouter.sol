// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "hardhat/console.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";

interface IOwnable {
    function owner() external view returns (address);
}

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
    function takeTax(address taxableToken, address from, bool isBuy, uint amount) external returns(uint taxToTake);
}

abstract contract TaxableRouter is OwnableUpgradeable, ReentrancyGuardUpgradeable {
    using SafeMath for uint;

    // The native blockchain token has no contract address (obviously).
    // We re-use the dead wallet address for that purpose.
    // We cannot use the zero address as storage can be initialized to that value.
    address constant internal ETH_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    // Outstanding taxes a token can claim.
    // Maps for example: CCMT => WETH => 5 ether.
    // Then CCMT contract can claim 5 ether of WETH.
    mapping(address => mapping(address => uint)) public tokenTaxesClaimable;
    // Wallets authorized to set fees for contracts.
    mapping(address => address) public feeOwners;

    /// @notice Modifier which only allows fee owners to change fees at all.
    /// @notice No other one (even not us) is able to set any token fees.
    /// @param token: Token of which `msg.sender` has to be the fee owner of.
    modifier byFeeOwner(address token) {
        require(msg.sender == feeOwners[token]);
        _;
    }

    // The taxes WE take from our clients.
    struct TokenBaseTax {
        bool isActive;
        uint16 tax;
    }
    // Remembers if a token has been registered by its owner to activate taxing.
    mapping(address => TokenBaseTax) public tokenBaseTax;
    // Save how many fees this router got so far for every taxable token.
    mapping(address => uint) public routerTaxesClaimable;
    /// @notice Makes sure only to take taxes on tax-activated tokens.
    /// @param token: Token to check if activated.
    modifier taxActive(address token) {
        if(tokenBaseTax[token].isActive){
            _;
        }
    }

    // Behaves like a constructor, but for upgradeables.
    function initialize() initializer internal {
        __ReentrancyGuard_init();
        __Ownable_init();
    }

    event SetTaxTierLevel(address, uint16);
    /// @notice Allows us to set a tax tier level for a certain token.
    /// @notice HOWEVER we can only make it "better".
    /// @notice So for tokens being unitialized we can set a max fee of 1%.
    /// @notice For tokens that are already initialized we can only set a lower fee than exists.
    /// @notice This is a safety measure for our clients. We don't want to harm anyone.
    /// @param token: Token to set tax tier for.
    /// @param tax: Taxes users have to pay (send to this router). Max 1% (but you can get less ;)).
    function setTaxTierLevel(address token, uint16 tax)
        external onlyOwner {
            // Max tax is 1%.
            require(tax <= 100, "CCM: SET_TAX_TIER_LEVEL_INVALID_TAX");
            TokenBaseTax memory taxEntry = tokenBaseTax[token];
            // If there is an entry the new tax has to be BETTER.
            require(!taxEntry.isActive || tax < taxEntry.tax, "CCM: SET_TAX_TIER_LEVEL_INVALID_TAX_UPDATE");
            tokenBaseTax[token] = TokenBaseTax(true, tax);
            emit SetTaxTierLevel(token, tax);
        }
    
    event ChoseTaxTierLevel(address, address);
    /// @notice Let's a fee owner choose a tier level by sending in the amount of BNB.
    /// @param token: Token to define a tax tier for.
    function chooseTaxTierLevel(address token)
     external payable byFeeOwner(token) {
        // We have a tier system here:
        // ----------------------------------------------
        // | Level      | Cost (in BNB) | Tax per trade |
        // ---------------------------------------------|
        // | Beginner   | 0             | 1%            |
        // | Apprentice | 5             | 0.5%          |
        // | Expert     | 10            | 0.3%          |
        // | Master     | ask us!       | 0%            |
        // ----------------------------------------------
        // The tier you get solely depends on the BNB you send in.
        // Your tier level CAN be changed later. Just call the method again.
        // We'll make sure that you can only upgrade e.g. not pay higher taxes than before, so no downgrade for you.
        uint apprenticeFee = 0.5 ether;
        uint expertFee = 1 ether;
        // The BNB sent in has to be one of the levels, otherwise we reject.
        // We also only want to have that exact amount, not more, not less.
        if(msg.value == expertFee){
            // Token must not be on expert level already
            TokenBaseTax memory existing = tokenBaseTax[token];
            require(!existing.isActive || existing.tax > 30);
            tokenBaseTax[token] = TokenBaseTax(true, 30);
        } else if(msg.value == apprenticeFee){
            // Token must not be on apprentice level or better already.
            TokenBaseTax memory existing = tokenBaseTax[token];
            require(!existing.isActive || existing.tax > 50);
            tokenBaseTax[token] = TokenBaseTax(true, 50);
        } else if(msg.value == 0) {
            // Token must not be initialized.
            TokenBaseTax memory existing = tokenBaseTax[token];
            require(!existing.isActive);
            tokenBaseTax[token] = TokenBaseTax(true, 100);
        } else {
            // No tier level selected. Reject.
            require(false, "CCM: NO_TIER_LEVEL_SELECTED");
        }
        routerTaxesClaimable[ETH_ADDRESS] += msg.value;
        emit ChoseTaxTierLevel(msg.sender, token);
    }
    /// @notice Allows to claim taxes of a specific token.
    /// @param token: Token in question to claim taxes from.
    function claimTaxes(address token, address taxableToken) public byFeeOwner(token){
        uint taxesToClaim = tokenTaxesClaimable[token][taxableToken];
        _claimTaxes(token, taxableToken, taxesToClaim);
    }
    /// @notice Does the tax claiming.
    /// @param token: Token in question to claim taxes from.
    /// @param taxableToken: Token from which those taxes have actually been taken from.
    function _claimTaxes(address token, address taxableToken, uint taxesToClaim) private nonReentrant {
        tokenTaxesClaimable[token][taxableToken] = 0;
        if(taxableToken == ETH_ADDRESS){
            (bool success, ) = payable(token).call{value: taxesToClaim}("");
            require(success);
            // Note: Here we are not calling the contract to inform it about the received tokens.
            // Reason is that the token already knows how many tokens it got and what the source has been.
            // The token can check for the sender address in its fallback function to notice it's a tax claim.
            // That way we safe gas by avoiding unnecessary calls.
        } else {
            require(IERC20(taxableToken).transfer(token, taxesToClaim));
            // This one is important. We notify the contract about the claim.
            // That way the contract can do various things such as adding liquidity
            // ,distributing funds (marketing, development) or other.
            ITaxToken(token).onTaxClaimed(taxableToken, taxesToClaim);
        }
    }
    event ClaimedInitialFeeOwnership(address, address);
    /// @notice Let's a token owner claim the initial fee ownership.
    /// @dev In order to make this working your token has to implement an owner() method 
    /// @dev that returns the address of the token owner.
    /// @dev After claim you can transfer the fee ownership if you like.
    /// @param token: Fee ownership to claim for token. You have to be the token owner.
    function claimInitialFeeOwnership(address token) external {
        require(feeOwners[token] == address(0x0), "CCM: FEE_OWNER_ALREADY_INITIALIZED");
        // The token owner shall have the power to claim the initial fee ownership.
        require(msg.sender == IOwnable(token).owner(), "CCM: FEE_OWNER_IS_NOT_TOKEN_OWNER");
        feeOwners[token] = msg.sender;
        emit ClaimedInitialFeeOwnership(msg.sender, token);
    }
    event TransferedFeeOwnership(address, address, address);
    /// @notice Transfers fee ownership to target owner.
    /// @notice This does not transfer the receiving of fees! It only allows `newOwner` to set new fees.
    /// @notice Obviously `newOwner` can now set itself to the fee receiver, but it's not happening automatically.
    /// @param token: The token to set fees for.
    /// @param newOwner: The new fee ownership holder.
    function transferFeeOwnership(
        address token, address newOwner
    ) external byFeeOwner(token) {
        feeOwners[token] = newOwner;
        emit TransferedFeeOwnership(msg.sender, token, newOwner);
    }
    /// @notice Allows the router owner to get the ETH given by for example tax tier level setup.
    /// @notice This function also ensures that the owner is NOT able to withdraw more ETH than being excessive.
    function withdrawRouterTaxes(address token) external onlyOwner {
        uint withdrawableTokens = routerTaxesClaimable[token];
        routerTaxesClaimable[token] = 0;
        console.log("Claiming %d", withdrawableTokens);
        if(withdrawableTokens > 0){ 
            if(token == TaxableRouter.ETH_ADDRESS){
                (bool success, ) = payable(owner()).call{value: withdrawableTokens}("");
                require(success);
            } else {
                require(IERC20(token).transfer(owner(), withdrawableTokens));
            }
        }
    }
    /// @notice Helper method to calculate the takes to take.
    /// @dev Actually we want to first multiply and then divide.
    /// @dev Reason is that division is potentially lossy when working on whole numbers.
    /// @dev For example 7 / 5 is 1.
    /// @dev Therefore first multiplying does not multiply with such a loss, hence increases accuracy.
    /// @dev But the multiplication could overflow which we don't want so we first check if that would happen
    /// @dev and if it is safe then we first multiply and then divide. Otherwise we just switch the ordering.
    function calculateTax(uint16 taxPercent, uint amount) private pure returns (uint tax) {
        if(taxPercent == 0) return 0;

        if(amount >= ~uint(0).div(taxPercent))
            tax = amount.div(10000).mul(taxPercent);
        else
            tax = amount.mul(taxPercent).div(10000);
    }
    /// @notice Takes the router tax for `taxableToken` defined by your token's tax level.
    /// @param token Your token to get your token's specific router tax.
    /// @param taxableToken The token we assign the taxes to (WETH e.g.)
    /// @param amount The total amount to take taxes from
    /// @return taxTaken The tax taken by us (the router)
    function takeRouterTax(address token, address taxableToken, uint amount) private returns (uint taxTaken){
        taxTaken = calculateTax(tokenBaseTax[token].tax, amount);
        routerTaxesClaimable[taxableToken] += taxTaken;
    }
    
    /// @notice Takes buy taxes when someone buys YOUR token.
    /// @notice For us for example it would be the path: WETH => CCMT.
    /// @param token The token being bought (you).
    /// @param taxableToken The token to take taxes from (WETH e.g.)
    /// @param amount The amount they put IN (WETH e.g.).
    /// @return amountLeft The amount of the given IN asset (WETH e.g.) that will actually used to buy.
    function takeBuyTax(
        address token, address taxableToken, 
        uint amount
    ) internal taxActive(token) returns(uint amountLeft, uint tokenTax) {
        // First ask the token how many taxes it wants to take.
        (uint tokenTaxToTake) = ITaxToken(token).takeTax(
            taxableToken, msg.sender, true, amount
        );
        require(tokenTaxToTake <= amount, "CCM: TAX_TOO_HIGH");
        
        // We take fees based upon your tax tier level,
        uint routerTaxToTake = takeRouterTax(token, taxableToken, amount);
        amountLeft = amount - tokenTaxToTake - routerTaxToTake;
        tokenTax = tokenTaxToTake;
    }
    /// @notice Takes sell taxes when someone sells YOUR token.
    /// @notice For us for example it would be the path: CCMT => WETH.
    /// @param token The token being sold (you).
    /// @param taxableToken The token to take taxes from (WETH e.g.)
    /// @param amount The amount they want to take OUT (WETH e.g.).
    /// @return amountLeft The amount of the OUT asset (WETH e.g.) that will actually sent to the seller.
    function takeSellTax(
        address token, address taxableToken, 
        uint amount
    ) internal taxActive(token) returns(uint amountLeft, uint tokenTax)  {
        // First ask the token how many taxes it wants to take.
        (uint tokenTaxToTake) = ITaxToken(token).takeTax(
            taxableToken, msg.sender, false, amount
        );
        require(tokenTaxToTake <= amount, "CCM: TAX_TOO_HIGH");
        
        uint routerTaxToTake = takeRouterTax(token, taxableToken, amount);
        amountLeft = amount - tokenTaxToTake - routerTaxToTake;
        tokenTax = tokenTaxToTake;
    }
}