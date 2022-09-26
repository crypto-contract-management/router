// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "./IPancakeRouter.sol";
import "./PcsPair.sol";
import "./TaxableRouter.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

library TransferHelper {
    function safeTransfer(address token, address to, uint value) internal {
        // bytes4(keccak256(bytes('transfer(address,uint256)')));
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, value));
        require(success && (data.length == 0 || abi.decode(data, (bool))), 'TransferHelper: TRANSFER_FAILED');
    }

    function safeTransferFrom(address token, address from, address to, uint value) internal {
        // bytes4(keccak256(bytes('transferFrom(address,address,uint256)')));
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, value));
        require(success && (data.length == 0 || abi.decode(data, (bool))), 'TransferHelper: TRANSFER_FROM_FAILED');
    }

    function safeTransferETH(address to, uint value) internal {
        (bool success,) = to.call{value:value}(new bytes(0));
        require(success, 'TransferHelper: ETH_TRANSFER_FAILED');
    }
}

contract CCMRouterV2 is TaxableRouter, UUPSUpgradeable {
    using SafeMath for uint;

    address public pcsRouter;
    address public pcsFactory;
    address public WETH;
    // List of taxable tokens.
    // For now: WETH.
    mapping(address => bool) public taxableToken;

    function initialize(address _pcsRouter, address _pcsFactory, address _weth) initializer public {
        TaxableRouter.initialize();
        pcsRouter = _pcsRouter;
        pcsFactory = _pcsFactory;
        WETH = _weth;
        setTaxableToken(_weth, true);
    }

    receive() external payable { }


    /// @notice Sets a taxable IERC20 token and potentially allows all routers to spend this token.
    /// @param token Token to tax
    function setTaxableToken(address token, bool isTaxable) public onlyOwner {
        if(isTaxable){
            taxableToken[token] = true;
            IERC20(token).approve(pcsRouter, ~uint(0));
        } else {
            taxableToken[token] = true;
            IERC20(token).approve(pcsRouter, uint(0));
        }
        
    }

/*
TCF => WETH => TCF2 => WETH2 => TCF3;
TCF => TCF2 => WETH => TCF3;
WETH => TCF => WETH;
WETH => WETH2 => TCF;
TCF => WETH => WETH2;
TCF => WETH => WETH2 => WETH3 => TCF2 => WETH4;
WETH => TCF => TCF2 => TCF3 => WETH2;
WETH => WETH2 => WETH3;

uint lastTaxAt = 0;
uint lastTaxAtValid = taxable[0] && !taxable[1];
for(uint i = 1; i < path.length; ++i)
    if taxable(i):
        if !taxable(i-1):
            if !taxable(lastTaxAt+1) && lastTaxAtValid:
                take buy fees;
            swap(path[lastTaxAt:i+1]);
            take sell fees;
        lastTaxAt = i;
        lastTaxAtValid = true;

if lastTaxAt != path.length - 1:
    if lastTaxAtValid    
        take buy fees;
    swap(path[lastTaxAt:])
*/
    function sortTokens(address a, address b) private pure returns(address token0, address token1) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }
    // calculates the CREATE2 address for a pair without making any external calls
    function pairFor(address factory, address tokenA, address tokenB) private pure returns (address pair) {
        (address token0, address token1) = sortTokens(tokenA, tokenB);
        pair = address(uint160(uint(keccak256(abi.encodePacked(
                hex'ff',
                factory,
                keccak256(abi.encodePacked(token0, token1)),
                keccak256(type(PancakePair).creationCode) // init code hash
            )))));
    }
/*
    function _swap(uint[] memory amounts, address[] memory path, address _to) internal virtual {
        for (uint i; i < path.length - 1; i++) {
            (address input, address output) = (path[i], path[i + 1]);
            (address token0,) = sortTokens(input, output);
            uint amountOut = amounts[i + 1];
            (uint amount0Out, uint amount1Out) = input == token0 ? (uint(0), amountOut) : (amountOut, uint(0));
            address to = i < path.length - 2 ? pairFor(pcsFactory, output, path[i + 2]) : _to;
            console.log("%s => %s", input, output);
            console.log("Pair is: %s", pairFor(pcsFactory, input, output));
            IPancakePair(pairFor(pcsFactory, input, output)).swap(
                amount0Out, amount1Out, to, new bytes(0)
            );
        }
    }
*/
    struct SwapInfo {
        uint totalSwapAmount;
        uint taxAmountToKeep;
    }

    // path:     CCMT             => WETH             => USDT             => SHIB
    // pairs:    CCMT/WETH        => WETH/USDT        => USDT/SHIB
    // taxInfos: (take x weth, .) => (take x USDT, .) => (take x SHIB, .)

    function _swap(address[] calldata path, SwapInfo[] memory taxInfos) private {
        for (uint i; i < path.length - 1; i++) {
            (address input, address output, address outputSuccessor) = (path[i], path[i + 1], path[i + 2]);
            (address token0,) = sortTokens(input, output);
            uint amountOut = taxInfos[i].totalSwapAmount;
            (uint amount0Out, uint amount1Out) = input == token0 ? (uint(0), amountOut) : (amountOut, uint(0));
            uint taxAmountToKeep = taxInfos[i].taxAmountToKeep;
            if(taxAmountToKeep > 0){
                IPancakePair(pairFor(pcsFactory, input, output)).swap(
                    amount0Out, amount1Out, address(this), new bytes(0)
                );
                IERC20(output).transfer(pairFor(pcsFactory, output, outputSuccessor), amountOut - taxAmountToKeep);
            } else {
                address to = i == path.length - 2 ? pairFor(pcsFactory, output, outputSuccessor) : address(this);
                IPancakePair(pairFor(pcsFactory, input, output)).swap(
                    amount0Out, amount1Out, to, new bytes(0)
                );
            }
        }
    }

    struct TokenTax {
        address token;
        address taxableToken;
        uint amount;
    } 

    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) public returns (uint[] memory amounts) {
        IPancakeRouter02 router = IPancakeRouter02(pcsRouter);
        amounts = new uint[](path.length);
        SwapInfo[] memory swapInfos = new SwapInfo[](path.length);
        
        IERC20(path[0]).transferFrom(msg.sender, pairFor(pcsFactory, path[0], path[1]), amountIn);
        // Create swap infos for every pair which takes taxes by 
        // not sending all available tokens to the pcs pairs.
        for(uint i = 0; i < path.length - 1; ++i){
            // path:     CCMT             => WETH             => USDT             => SHIB
            // Buy
            if(taxableToken[path[i + 1]] && !taxableToken[path[i + 2]]){
                (uint amountLeft,  uint tokenTax) = takeBuyTax(path[i + 1], path[i], amountIn);
                uint[] memory tokensOut = router.getAmountsOut((amountIn = amountLeft), path[i:i + 2]);
                swapInfos[i] = SwapInfo(amountIn, amountIn - amountLeft);
                amounts[i] = tokensOut[0];
                amounts[i + 1] = amountIn = tokensOut[1];
            }
            // Sell
            else if(!taxableToken[path[i]] && taxableToken[path[i + 1]]){
                uint[] memory tokensOut = router.getAmountsOut(amountIn, path[i:i + 2]);
                (uint amountLeft, uint tokenTax) = takeSellTax(path[i], path[i + 1], tokensOut[1]);
                swapInfos[i] = SwapInfo(amountIn, amountIn - amountLeft);
                amounts[i] = tokensOut[0];
                amounts[i + 1] = amountIn = amountLeft;
            } else {
                uint[] memory tokensOut = router.getAmountsOut(amountIn, path[i:i + 2]);
                swapInfos[i] = SwapInfo(amountIn, 0);
                amounts[i] = tokensOut[0];
                amounts[i + 1] = amountIn = tokensOut[1];
            }
        }
        _swap(path, swapInfos);
        require(IERC20(path[path.length - 1]).transfer(to, amounts[amounts.length - 1]));
    }
    function swapTokensForExactTokens(
        uint amountOut,
        uint amountInMax,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts) {
        require(false, "Coming soon!");
    }
    function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline)
        public
        virtual
        payable
        returns (uint[] memory amounts)
    {
        address tokenToSwap = path[1];
        (uint ethToTransfer, uint ethTax) = takeBuyTax(tokenToSwap, TaxableRouter.ETH_ADDRESS, msg.value);
        // Swap tokens and send to this router.
        amounts = IPancakeRouter02(pcsRouter).swapExactETHForTokens{value: ethToTransfer}(amountOutMin, path, address(this), deadline);
        require(IERC20(tokenToSwap).transfer(to, amounts[amounts.length - 1]));
    }
    function swapTokensForExactETH(uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline)
        external
        virtual
        returns (uint[] memory amounts)
    {
        address tokenToSwap = path[0];
        address weth = path[path.length - 1];
        // Transfer tokens from caller to this router and then swap these tokens via PCS.
        // Save BNB balance before and after to know how much BNB to send the caller after swapping.
        uint tokensNeeded = IPancakeRouter02(pcsRouter).getAmountsIn(amountOut, path)[0];
        require(tokensNeeded <= amountInMax, 'CCM: NOT_ENOUGH_OUT_FOR_IN');
        TransferHelper.safeTransferFrom(
            tokenToSwap, msg.sender, address(this), tokensNeeded
        );
        IERC20(tokenToSwap).approve(pcsRouter, tokensNeeded);
        amounts = IPancakeRouter02(pcsRouter).swapTokensForExactETH(amountOut, amountInMax, path, address(this), deadline);
        // The caller does not receive 100% of the ETH gained, the fees are subtracted before.
        (uint ethToTransfer, uint ethTax) = takeSellTax(
            tokenToSwap, TaxableRouter.ETH_ADDRESS,
            amounts[amounts.length - 1]);
        // Now send to the caller.
        TransferHelper.safeTransferETH(to, ethToTransfer);
    }
    function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline)
        public
        virtual
        returns (uint[] memory amounts)
    {
        address tokenToSwap = path[0];
        address weth = path[path.length - 1];
        assert(weth == WETH);
        // Transfer tokens from caller to this router and then swap these tokens via PCS.
        // Save BNB balance before and after to know how much BNB to send the caller after swapping.
        IERC20(tokenToSwap).transferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenToSwap).approve(pcsRouter, amountIn);
        amounts = IPancakeRouter02(pcsRouter).swapExactTokensForETH(amountIn, amountOutMin, path, address(this), deadline);
        // The caller does not receive 100% of the ETH gained, the fees are subtracted before.
        (uint ethToTransfer, uint ethTax) = takeSellTax(
            tokenToSwap, TaxableRouter.ETH_ADDRESS, 
            amounts[amounts.length - 1]);
        // Now send to the caller.
        TransferHelper.safeTransferETH(to, ethToTransfer);
    }
    function swapETHForExactTokens(uint amountOut, address[] calldata path, address to, uint deadline)
        external
        virtual
        payable
        returns (uint[] memory amounts)
    {
        // We only work with taxes between direct pairs of WETH <=> Token for now.
        address tokenToSwap = path[1];
        (uint ethToTransfer, uint ethTax) = takeBuyTax(tokenToSwap, TaxableRouter.ETH_ADDRESS, msg.value);
        // Swap tokens and send to this router.
        amounts = IPancakeRouter02(pcsRouter).swapETHForExactTokens{value: ethToTransfer}(amountOut, path, address(this), deadline);
        require(IERC20(tokenToSwap).transfer(to, amounts[amounts.length - 1]), "Final transfer failed");
    }

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external virtual {
        uint[] memory amounts = swapExactTokensForTokens(amountIn, amountOutMin, path, address(this), deadline);
        uint tokensToSend = amounts[amounts.length - 1];
        require(tokensToSend >= amountOutMin, "CCM: LESS_OUT");
        require(IERC20(path[path.length - 1]).transfer(to, tokensToSend), "Final transfer failed");
    }
    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    )
        external
        virtual
        payable
    {
        address tokenToSwap = path[1];
        uint[] memory amounts = swapExactETHForTokens(amountOutMin, path, address(this), deadline);
        uint tokensToSend = amounts[amounts.length - 1];
        require(tokensToSend >= amountOutMin, "CCM: LESS_OUT");
        require(IERC20(tokenToSwap).transfer(to, tokensToSend), "Final transfer failed");
    }
    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    )
        external
        virtual
    {
        uint[] memory amounts = swapExactTokensForETH(amountIn, amountOutMin, path, address(this), deadline);
        uint tokensToSend = amounts[amounts.length - 1];
        require(tokensToSend >= amountOutMin, "CCM: LESS_OUT");
        TransferHelper.safeTransferETH(to, tokensToSend);
    }

    function _authorizeUpgrade(address newImplementation) internal virtual override {
        require(msg.sender == owner(), "CCM: CANNOT_UPGRADE");
    }

    function withdrawAnyERC20Token(address token) external onlyOwner {
        IERC20(token).transfer(owner(), IERC20(token).balanceOf(address(this)));
    }
}