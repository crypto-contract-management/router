// SPDX-License-Identifier: MIT
import "./TaxTokenBase.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IPancakePair {
    function sync() external;
}

contract CryptoContractManagement is UUPSUpgradeable, PausableUpgradeable, OwnableUpgradeable, TaxTokenBase {

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
    TaxStats public buyTax;
    TaxStats public sellTax;
    // We also keep track of individual sells to punish wallets causing a huge drop.
    struct WalletIndividualSellTax {
        uint16 cummulativeSellPercent;
        uint lastUpdated;
    }
    mapping(address => WalletIndividualSellTax) public walletSellTaxes;
    // Three tax receivers: Development/marketing, liquidity, reflections.
    struct TaxDistribution {
        address developmentWallet;
        address reflectionsWallet;
        address autoLiquidityWallet;
        uint16 developmentTaxPercent;
        uint16 reflectionsTaxPercent;
        uint16 autoLiquidityTaxPercent;
    }
    TaxDistribution public taxDistribution;
    // Threshold to increase common sell taxes when too much tokens are sold.
    uint16 public increaseSellTaxThreshold;
    // Access control
    mapping(address => bool) public isBlacklisted;
    modifier notBacklisted(address who){
        require(!isBlacklisted[who]);
        _;
    }
    // Swap info
    address public pancakePair;
    address public pancakeRouter;
    uint private reflectionBalance;

    event TaxSettingsUpdated(uint16, uint16, uint16, uint32, uint32, uint, uint);
    function setTaxSettings(
        bool isBuy,
        uint16 minTax, uint16 maxTax, uint16 currentTax, 
        uint32 resetTaxAfter, uint32 resetMaxTaxAfter, 
        uint lastUpdated, uint lastPrice) external onlyOwner {
        require(minTax <= currentTax && currentTax <= maxTax, "CCM: INVALID_TAX_SETTING");
        TaxStats memory existingTax = isBuy ? buyTax : sellTax;
        TaxStats memory newTax = TaxStats(
            minTax == 0 ? existingTax.minTax : minTax,
            maxTax == 0 ? existingTax.maxTax : maxTax,
            currentTax == 0 ? existingTax.currentTax : currentTax,
            resetTaxAfter == 0 ? existingTax.resetTaxAfter : resetTaxAfter,
            resetMaxTaxAfter == 0 ? existingTax.resetMaxTaxAfter : resetMaxTaxAfter,
            lastUpdated == 0 ? existingTax.lastUpdated : lastUpdated,
            lastPrice == 0 ? existingTax.lastPrice : lastPrice
        );
        if(isBuy)
            buyTax = newTax;
        else
            sellTax = newTax;

        emit TaxSettingsUpdated(minTax, maxTax, currentTax, resetTaxAfter, resetMaxTaxAfter, lastUpdated, lastPrice);
    }
    
    event WalletSellTaxesUpdated(address, uint16, uint);
    function setWalletSellTaxes(address who, uint16 cummulativeTaxPercent, uint lastUpdated) external onlyOwner {
        WalletIndividualSellTax memory walletTaxes = walletSellTaxes[who];
        walletTaxes.cummulativeSellPercent = cummulativeTaxPercent;
        walletTaxes.lastUpdated = lastUpdated;
        walletSellTaxes[who] = walletTaxes;

        emit WalletSellTaxesUpdated(who, cummulativeTaxPercent, lastUpdated);
    }

    event TaxDistributionUpdated(address, address, address, uint16, uint16, uint16);
    function setTaxDistribution(
        address developmentWallet, address reflectionsWallet, address autoLiquidityWallet,
        uint16 developmentTaxPercent, uint16 reflectionsTaxPercent, uint16 autoLiquidityTaxPercent
    ) external onlyOwner {
        require(
            developmentTaxPercent + reflectionsTaxPercent + autoLiquidityTaxPercent == 1000,
            "CCM: INVALID_TAX_DISTRIB"
        );
        TaxDistribution memory taxes = taxDistribution;
        if(developmentWallet != address(0))
            taxes.developmentWallet = developmentWallet;
        if(reflectionsWallet != address(0))
            taxes.reflectionsWallet = reflectionsWallet;
        if(autoLiquidityWallet != address(0))
            taxes.autoLiquidityWallet = autoLiquidityWallet;
        
        taxes.developmentTaxPercent = developmentTaxPercent;
        taxes.reflectionsTaxPercent = reflectionsTaxPercent;
        taxes.autoLiquidityTaxPercent = autoLiquidityTaxPercent;
        taxDistribution = taxes;

        emit TaxDistributionUpdated(
            developmentWallet, reflectionsWallet, autoLiquidityWallet, 
            developmentTaxPercent, reflectionsTaxPercent, autoLiquidityTaxPercent
        );
    }

    function initialize(address _router) external initializer {
        TaxTokenBase.init(_router, "CryptoContractManagement", "CCM");
        __Ownable_init();
        __Pausable_init();

        buyTax = TaxStats(30, 50, 50, 0, 0, 0, 0);
        sellTax = TaxStats(100, 200, 100, 2 hours, 4 hours, 0, 0);
        taxDistribution = TaxDistribution(
            msg.sender, msg.sender, address(0),
            450, 350, 200
        );
        increaseSellTaxThreshold = 30;

        // We have a total of 100M tokens.
        _mint(msg.sender, 10**8 * 1 ether);
    }

    event PairAddressUpdated(address);
    function setPairAddress(address pair) external onlyOwner {
        isTaxablePair[pancakePair] = false;
        pancakePair = pair;
        isTaxablePair[pancakePair] = true;

        emit PairAddressUpdated(pair);
    }

    event PancakeRouterUpdated(address);
    function setPancakeRouter(address router) external onlyOwner {
        pancakeRouter = router;
        
        emit PancakeRouterUpdated(router);
    }

    event IsBlacklistedUpdated(address, bool);
    function setIsBlacklisted(address who, bool _isBlackListed) external onlyOwner {
        isBlacklisted[who] = _isBlackListed;

        emit IsBlacklistedUpdated(who, _isBlackListed);
    }

    function _handleAutoLiquidityTaxes(address liquidityPair, address taxableToken, uint taxes) private {
        require(liquidityPair != address(0), "CCM: Invalid liquidity address");
        // We simply transfer our liquidity to the pair and sync the internal balances.
        IERC20(taxableToken).transfer(liquidityPair, taxes);
        IPancakePair(liquidityPair).sync();
    }

    function _handleReflectionsTaxes(address reflectionsWallet, uint taxes) private {
        // When the reflection balances reaches the 1eth threshold process it by the dividend tracker.
        uint currentReflectionBalance = reflectionBalance + taxes;
        if(currentReflectionBalance >= 1 ether){
            // Send rewards to users.
            reflectionBalance = 0;
        }
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
        _handleAutoLiquidityTaxes(taxes.autoLiquidityWallet, taxableToken, autoLiquidityTaxes);
    }


    function _tokensLeftAfterTax(uint amountIn, uint16 tax) private pure returns(uint tokensLeft) {
        // Higher precision is first mul then div. If that would cause an overflow do it the other way around.
        bool preciseMode = ~uint(0) / tax > amountIn;
        unchecked {
            if(preciseMode)
                tokensLeft = amountIn * tax / 1000;
            else
                tokensLeft = amountIn / 1000 * tax;
        }
    }
    function _takeBuyTax(uint amountIn) private view returns (uint buyTaxToTake) {
        // If the token performs well we can reduce the buy tax down to a certain amount.
        // Will do that in the future, for now it shall be a static value.
        buyTaxToTake = _tokensLeftAfterTax(amountIn, buyTax.currentTax);
    }
    // Sell tax will increase to 20% if sell pressure is high.
    // Each sell increase will be kept for 2h, once reached the max sell tax it will stay for 4h.
    // No worries though: We put a lot of token fees right back in into the token itself, so you profit from that!
    function _takeSellTax(address taxableToken, address from, uint amountIn) private returns (uint sellTaxToTake) {
        TaxStats memory currentSellTax = sellTax;
        WalletIndividualSellTax memory currentUserSellTax = walletSellTaxes[from];
        uint tokenBalance = IERC20(taxableToken).balanceOf(pancakePair);
        // Update most recent price if never set (beginning) or balance increased (someone bought before someone sold).
        if(currentSellTax.lastPrice == 0 || tokenBalance > currentSellTax.lastPrice)
            currentSellTax.lastPrice = tokenBalance;
        // Reset tax after certain interval.
        if(block.timestamp >= currentSellTax.lastUpdated + currentSellTax.resetTaxAfter){
            currentSellTax.lastUpdated = block.timestamp;
            currentSellTax.currentTax = currentSellTax.minTax;
            currentSellTax.lastPrice = tokenBalance;
        } 
        uint balanceDroppedInPercent = amountIn  * 1000 / tokenBalance;
        // Handle common token taxes.
        if(currentSellTax.currentTax < currentSellTax.maxTax) {
            // If the balance would drop by `increaseSellTaxThreshold` we increase the tax gradually.
            if(balanceDroppedInPercent >= increaseSellTaxThreshold){
                // Decrease sell tax 4 times before reaching the max tax state.
                uint16 taxStep = (currentSellTax.maxTax - currentSellTax.minTax) / 4;
                // If this one sell is big enough it could force multiple tax steps.
                uint taxStepsTaken = balanceDroppedInPercent / increaseSellTaxThreshold;
                currentSellTax.currentTax += uint16(taxStep * taxStepsTaken);
                // If we reached max sell tax lock it for `resetMaxTaxAfter`.
                // We reach that by updating `lastUpdated accordingly`.
                currentSellTax.lastUpdated = block.timestamp;
                if(currentSellTax.currentTax >= currentSellTax.maxTax){
                    currentSellTax.currentTax = currentSellTax.maxTax;
                    currentSellTax.lastUpdated += (currentSellTax.resetMaxTaxAfter - currentSellTax.resetTaxAfter);
                }
            }
        } else if(block.timestamp >= currentSellTax.lastUpdated + currentSellTax.resetTaxAfter) {
            currentSellTax.currentTax = currentSellTax.maxTax;
            currentSellTax.lastUpdated = block.timestamp + (currentSellTax.resetMaxTaxAfter - currentSellTax.resetTaxAfter);
        }
        // Handle user-specific selling. This is reset every 24h.
        if(block.timestamp >= currentUserSellTax.lastUpdated + 24 hours){
            currentUserSellTax.cummulativeSellPercent = uint16(balanceDroppedInPercent);
            if(currentUserSellTax.cummulativeSellPercent > 350)
                currentUserSellTax.cummulativeSellPercent = 350;
            currentUserSellTax.lastUpdated = block.timestamp;
        }
        else if(currentUserSellTax.cummulativeSellPercent < 350){
            currentUserSellTax.cummulativeSellPercent += uint16(balanceDroppedInPercent);
            if(currentUserSellTax.cummulativeSellPercent > 350)
                currentUserSellTax.cummulativeSellPercent = 350;
        }
        // Every user may sell enough tokens to induce a drop of 5% without any extra fees.
        // After that they pay a maximum of 15% extra fees if they sold enough to drop the price by 35%.
        uint16 userTaxToTake = currentUserSellTax.cummulativeSellPercent > 50 ? (currentUserSellTax.cummulativeSellPercent - 50) / 2 : 0;
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
    function takeTax(address taxableToken, address from, bool isBuy, uint amount) external notBacklisted(from) override returns(uint taxToTake) {
        if(isBuy)
            taxToTake = _takeBuyTax(amount);
        else
            taxToTake = _takeSellTax(taxableToken, from, amount);
    }

    event TaxesWithdrawn(address, address, uint);
    /// @notice Used to withdraw the token taxes.
    /// @notice DEVs must not forget to implement such a function, otherwise funds may not be recoverable
    /// @notice unless they send their taxes to wallets during `onTaxClaimed`.
    /// @param token The token to withdraw.
    /// @param to Token receiver.
    /// @param amount The amount to withdraw.
    function withdrawTax(address token, address to, uint amount) external override onlyOwner {
        IERC20(token).transfer(to, amount);

        emit TaxesWithdrawn(token, to, amount);
    }

    function _authorizeUpgrade(address newImplementation) internal virtual override {
        require(msg.sender == owner(), "CCM: CANNOT_UPGRADE");
    }

}