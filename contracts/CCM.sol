import "./TaxTokenBase.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract CryptoContractManagement is UUPSUpgradeable, OwnableUpgradeable, TaxTokenBase {

    // Tax settings
    struct TaxStats {
        uint16 minTax;
        uint16 maxTax;
        uint16 currentTax;
        uint32 resetTaxAfter;
        uint32 resetMaxTaxAfter;
        uint lastUpdated;
        uint lastPrice;
    }
    TaxStats buyTax = TaxStats(30, 50, 50, 0, 0, 0, 0);
    TaxStats sellTax = TaxStats(100, 200, 100, 2 hours, 4 hours, 0, 0);
    // We also keep track of individual sells to punish wallets causing a huge drop.
    struct WalletIndividualSellTax {
        uint16 cummulativeSellPercent;
        uint lastUpdated;
    }
    mapping(address => WalletIndividualSellTax) private walletSellTaxes;

    function initialize(address _router) external initializer {
      TaxTokenBase.init(_router);
    }

    // Three tax receivers: Development/marketing, liquidity, reflections.
    struct TaxDistribution {
        address developmentWallet;
        address reflectionsWallet;
        address autoLiquidityWallet;
        uint16 developmentTaxPercent;
        uint16 reflectionsTaxPercent;
        uint16 autoLiquidityTaxPercent;
    }
    TaxDistribution taxDistribution = TaxDistribution(
        address(0), address(0), address(0),
        450, 350, 200
    );

    function _handleAutoLiquidityTaxes(address liquidityWallet, uint taxes) private {

    }
    function _handleReflectionsTaxes(address reflectionsWallet, uint taxes) private {

    }
    /// @notice Called after you claimed tokens.
    /// @dev Keep logic small. Your users (eventually) pay the gas for it.
    /// @param taxableToken The token you've been sent (like WETH)
    /// @param amount The amount transferred
    function onTaxClaimed(address taxableToken, uint amount) external override {
        // Here we're now distributing funds accordingly.
        TaxDistribution memory taxes = taxDistribution;
        uint developmentTaxes = amount * taxes.developmentTaxPercent / 1000;
        uint reflectionsTaxes = amount * taxes.reflectionsTaxPercent / 1000;
        uint autoLiquidityTaxes = amount * taxes.autoLiquidityTaxPercent / 1000;
        IERC20(taxableToken).transfer(taxes.developmentWallet, developmentTaxes);
        _handleReflectionsTaxes(taxes.reflectionsWallet, reflectionsTaxes);
        _handleAutoLiquidityTaxes(taxes.autoLiquidityWallet, autoLiquidityTaxes);
    }


    function _tokensLeftAfterTax(uint amountIn, uint16 tax) private pure returns(uint tokensLeft) {
        // Higher precision is first mul then div. If that would cause an overflow do it the other way around.
        bool unpreciseMode = ~uint(0) / tax > amountIn;
        unchecked {
            if(unpreciseMode)
                tokensLeft = amountIn / 1000 * tax;
            else
                tokensLeft = amountIn * tax / 1000;
        }
    }
    function _takeBuyTax(uint amountIn) private view returns (uint buyTaxToTake) {
        // If the token performs well we can reduce the buy tax down to a certain amount.
        // Will do that in the future, for now it shall be a static value.
        buyTaxToTake = _tokensLeftAfterTax(amountIn, buyTax.currentTax);
    }
    // Threshold to increase common sell taxes is 3% drop.
    uint private increaseSellTaxThreshold = 30;
    // Sell tax will increase to 20% if sell pressure is high.
    // Each sell increase will be kept for 2h, once reached the max sell tax it will stay for 4h.
    // No worries though: We put a lot of token fees right back in into the token itself, so you profit from that!
    function _takeSellTax(address taxableToken, address from, uint amountIn) private returns (uint sellTaxToTake) {
        TaxStats memory currentSellTax = sellTax;
        WalletIndividualSellTax memory currentUserSellTax = walletSellTaxes[from];
        uint tokenBalance = IERC20(taxableToken).balanceOf(address(this));
        // Update most recent price if never set (beginning) or balance increased (someone bought before someone sold).
        if(currentSellTax.lastPrice == 0 || tokenBalance > currentSellTax.lastPrice)
            currentSellTax.lastPrice = tokenBalance;
        // Reset tax after certain interval.
        if(block.timestamp >= currentSellTax.lastUpdated + currentSellTax.resetTaxAfter){
            currentSellTax.lastUpdated = block.timestamp;
            currentSellTax.currentTax = currentSellTax.minTax;
            currentSellTax.lastPrice = tokenBalance;
        } 
        uint balanceDroppedInPercent = (currentSellTax.lastPrice - amountIn) / currentSellTax.lastPrice * 100;
        // Handle common token taxes.
        if(currentSellTax.currentTax < currentSellTax.maxTax) {
            // If the balance would drop by `increaseSellTaxThreshold` we increase the tax gradually.
            if(balanceDroppedInPercent >= increaseSellTaxThreshold){
                // Decrease sell tax 4 times before reaching the max tax state.
                uint16 taxStep = (currentSellTax.maxTax - currentSellTax.minTax) / 4;
                currentSellTax.currentTax += taxStep;
                // If we reached max sell tax lock it for `resetMaxTaxAfter`.
                // We reach that by updating `lastUpdated accordingly`.
                currentSellTax.lastUpdated = block.timestamp;
                if(currentSellTax.currentTax == currentSellTax.maxTax)
                    currentSellTax.lastUpdated += (currentSellTax.resetMaxTaxAfter - currentSellTax.resetTaxAfter);
            }
        }
        // Handle user-specific selling. This is reset every 24h.
        if(block.timestamp >= currentUserSellTax.lastUpdated + 24 hours){
            currentUserSellTax.cummulativeSellPercent = uint16(balanceDroppedInPercent);
            if(currentUserSellTax.cummulativeSellPercent > 25)
                currentUserSellTax.cummulativeSellPercent = 25;
            currentUserSellTax.lastUpdated = block.timestamp;
        }
        else if(currentUserSellTax.cummulativeSellPercent < 25){
            currentUserSellTax.cummulativeSellPercent += uint16(balanceDroppedInPercent);
            if(currentUserSellTax.cummulativeSellPercent > 25)
                currentUserSellTax.cummulativeSellPercent = 25;
        }
        // Every user may sell enough tokens to induce a drop of 5% without any extra fees.
        // After that they pay a maximum of 10% extra fees if they sold enough to drop the price by 25%.
        uint16 userTaxToTake = (currentUserSellTax.cummulativeSellPercent - 5) / 2;
        // Now that we updated the (user) struct save it and calculate the necessary tax.
        walletSellTaxes[from] = currentUserSellTax;
        sellTax = currentSellTax;
        sellTaxToTake = _tokensLeftAfterTax(amountIn, currentSellTax.currentTax + userTaxToTake);
    }
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
    function takeTax(address taxableToken, address from, bool isBuy, uint amount) external override returns(uint taxToTake) {
        if(isBuy)
            taxToTake = _takeBuyTax(amount);
        else
            taxToTake = _takeSellTax(taxableToken, from, amount);
    }
    /// @notice Used to withdraw the token taxes.
    /// @notice DEVs must not forget to implement such a function, otherwise funds may not be recoverable
    /// @notice unless they send their taxes to wallets during `onTaxClaimed`.
    /// @param token The token to withdraw.
    /// @param to Token receiver.
    /// @param amount The amount to withdraw.
    function withdrawTax(address token, address to, uint amount) external override onlyOwner {
        IERC20(token).transfer(to, amount);
    }

    function _authorizeUpgrade(address newImplementation) internal virtual override {
        require(msg.sender == owner(), "CCM: CANNOT_UPGRADE");
    }

}