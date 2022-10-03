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

interface IWETH {
    function deposit() external payable;
    function transfer(address to, uint value) external returns (bool);
    function withdraw(uint) external;
}

contract CCMRouter is TaxableRouter, UUPSUpgradeable {
    address public pcsRouter;
    address public pcsFactory;
    address public WETH;
    // List of taxable tokens.
    mapping(address => bool) public taxableToken;
    // Data differing between test and live chain
    bytes32 constant pcsPairInitHash = hex"358508d6f346d29248ea82784d04fb74725d6221815dcd6b3a6ecb82fb39a7bd";
    //bytes32 constant pcsPairInitHash = hex"ecba335299a6693cb2ebc4782e74669b84290b6378ea3a3873c7231a8d7d1074"; // testnet

    modifier ensure(uint deadline) {
        require(deadline >= block.timestamp || deadline == 0);
        _;
    }

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

    function sortTokens(address a, address b) private pure returns(address token0, address token1) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }
    // calculates the CREATE2 address for a pair without making any external calls
    function pairFor(address factory, address tokenA, address tokenB) private view returns (address pair) {
        (address token0, address token1) = sortTokens(tokenA, tokenB);
        pair = address(uint160(uint(keccak256(abi.encodePacked(
                hex'ff',
                factory,
                keccak256(abi.encodePacked(token0, token1)),
                pcsPairInitHash
            )))));
    }

    // given an input amount of an asset and pair reserves, returns the maximum output amount of the other asset
    function getAmountOut(address pair, address inAddress, uint amountIn, address outAddress) internal view returns (uint amountOut) {
        (address token0,) = sortTokens(inAddress, outAddress);
        (uint reserve0, uint reserve1,) = IPancakePair(pair).getReserves();
        (uint reserveIn, uint reserveOut) = inAddress == token0 ? (reserve0, reserve1) : (reserve1, reserve0);
        uint amountInWithFee = amountIn * 9975;
        uint numerator = amountInWithFee * reserveOut;
        uint denominator = reserveIn * 10000 + amountInWithFee;
        amountOut = numerator / denominator;
    }

    struct SwapInfo {
        uint tokensToTakeOut;
        uint tokensToSendFurther;
    }
    struct TaxInfo {
        address taxReceiver;
        address taxableToken;
        uint tokenTaxes;
    }

    function getPairAddress(address token0, address token1) external view {
        address p = pairFor(address(0xB7926C0430Afb07AA7DEfDE6DA862aE0Bde767bc), token0, token1);
        console.log(token0, token1, "0xb7926c0430afb07aa7defde6da862ae0bde767bc");
        console.log(p);

    }

    function _swap(address[] calldata path, SwapInfo[] memory taxInfos) private {
        bytes memory payload = new bytes(0);
        uint i;
        for (; i < path.length - 2; i++) {
            SwapInfo memory tokenSwapInfo = taxInfos[i];
            (address input, address output, address outputSuccessor) = (path[i], path[i + 1], path[i + 2]);
            address currentPair = pairFor(pcsFactory, input, output);
            address nextPair = pairFor(pcsFactory, output, outputSuccessor);
            (address token0,) = sortTokens(input, output);
            (uint amount0Out, uint amount1Out) = input == token0 ? (uint(0), tokenSwapInfo.tokensToTakeOut) : (tokenSwapInfo.tokensToTakeOut, uint(0));
            if(tokenSwapInfo.tokensToTakeOut - tokenSwapInfo.tokensToSendFurther > 0){
                IPancakePair(currentPair).swap(amount0Out, amount1Out, address(this), payload);
                IERC20(output).transfer(nextPair, tokenSwapInfo.tokensToSendFurther);
            } else {
                IPancakePair(currentPair).swap(amount0Out, amount1Out, nextPair, payload);
            }
        }
        // Run last iteration manually and send tokens to us.
        (address input, address output) = (path[path.length - 2], path[path.length - 1]);
        (address token0,) = sortTokens(input, output);
        
        uint amountOut = taxInfos[i].tokensToTakeOut;
        (uint amount0Out, uint amount1Out) = input == token0 ? (uint(0), amountOut) : (amountOut, uint(0));
        IPancakePair(pairFor(pcsFactory, input, output)).swap(amount0Out, amount1Out, address(this), payload);
    }
    
    function _getSwapInfos(uint amountIn, address[] calldata path) private returns(
        uint[] memory amounts, SwapInfo[] memory swapInfos, TaxInfo[] memory taxInfos) {
        amounts = new uint[](path.length);
        swapInfos = new SwapInfo[](path.length - 1);
        taxInfos = new TaxInfo[](path.length - 1);

        // The first swap can be a buy and we just take taxes for that one immediately.
        if(taxableToken[path[0]] && !taxableToken[path[1]]){
            (uint amountLeft,  uint tokenTax) = takeBuyTax(path[1], path[0], amountIn);
            uint tokensOut = getAmountOut(pairFor(pcsFactory, path[0], path[1]), path[0], amountLeft, path[1]);
            swapInfos[0] = SwapInfo(tokensOut, amountLeft);
            taxInfos[0] = TaxInfo(path[1], path[0], tokenTax);
            amounts[0] = amountIn = amountLeft;
            amounts[1] = tokensOut;
        } else {
            amounts[0] = amountIn;
        }
        // Create swap infos for every pair which takes taxes by 
        // not sending all available tokens to the pcs pairs.
        for(uint i = 0; i < path.length - 1; ++i){
            uint tokensOut = getAmountOut(pairFor(pcsFactory, path[i], path[i + 1]), path[i], amountIn, path[i + 1]);
            bool isSell = !taxableToken[path[i]] && taxableToken[path[i + 1]];
            bool nextIsBuy = taxableToken[path[i + 1]] && i < path.length - 2 && !taxableToken[path[i + 2]];
            // Sell
            if(isSell){
                (uint amountLeft, uint tokenTax) = takeSellTax(path[i], path[i + 1], tokensOut);
                swapInfos[i] = SwapInfo(tokensOut, amountLeft);
                taxInfos[i] = TaxInfo(path[i], path[i + 1], tokenTax);
                amounts[i + 1] = amountIn = tokensOut = amountLeft;
            }
            // Buy
            if(nextIsBuy){
                (uint amountLeft,  uint tokenTax) = takeBuyTax(path[i + 2], path[i + 1], tokensOut);
                // If we already got a sell before and now we take immediate buy taxes
                // we have a swap of for example CCMT => WETH => SHIB.
                // Make sure the tax infos are at their correct place for that case (+1).
                // Also we have to further reduce the amount to send further for the existing swap info.
                if(isSell){
                    swapInfos[i].tokensToSendFurther = amountLeft;
                    taxInfos[i + 1] = TaxInfo(path[i + 2], path[i + 1], tokenTax);
                }
                else{
                    swapInfos[i] = SwapInfo(tokensOut, amountLeft);
                    taxInfos[i] = TaxInfo(path[i + 2], path[i + 1], tokenTax);
                }
                amounts[i + 1] = amountIn = amountLeft;
            }
            if(swapInfos[i].tokensToTakeOut == 0) {
                
                swapInfos[i] = SwapInfo(tokensOut, tokensOut);
                amounts[i + 1] = amountIn = tokensOut;
            }
        }
    }

    function _swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) private returns (uint[] memory amounts) {
        (uint[] memory swapAmounts, SwapInfo[] memory swapInfos, TaxInfo[] memory taxInfos) = _getSwapInfos(amountIn, path);
        amounts = swapAmounts;

        require(amounts[amounts.length - 1] >= amountOutMin, "CCM: LESS_OUT");
        IERC20(path[0]).transfer(pairFor(pcsFactory, path[0], path[1]), amounts[0]);
        _swap(path, swapInfos);
        // Distribute taxes.
        for(uint i = 0; i < taxInfos.length; ++i){
            TaxInfo memory si = taxInfos[i];
            if(si.tokenTaxes > 0 && si.taxableToken != address(0)){
                IERC20(si.taxableToken).transfer(si.taxReceiver, si.tokenTaxes);
                ITaxToken(si.taxReceiver).onTaxClaimed(si.taxableToken, si.tokenTaxes);
            }
        }
    }

    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external ensure(deadline) returns (uint[] memory amounts){
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        amounts = _swapExactTokensForTokens(amountIn, amountOutMin, path, to, deadline);
        require(IERC20(path[path.length - 1]).transfer(to, amounts[amounts.length - 1]));
    }

    function swapTokensForExactTokens(
        uint amountOut,
        uint amountInMax,
        address[] calldata path,
        address to,
        uint deadline
    ) external ensure(deadline) returns (uint[] memory amounts) {
        require(false, "Coming soon!");
    }
    function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline)
        public
        virtual
        payable
        ensure(deadline)
        returns (uint[] memory amounts)
    {
        uint amountIn = msg.value;
        IWETH(WETH).deposit{value: amountIn}();
        amounts = _swapExactTokensForTokens(amountIn, amountOutMin, path, to, deadline);
        require(IERC20(path[path.length - 1]).transfer(to, amounts[amounts.length - 1]));
    }
    function swapTokensForExactETH(uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline)
        external
        virtual
        ensure(deadline)
        returns (uint[] memory amounts)
    {
        // Transfer tokens from caller to this router and then swap these tokens via PCS.
        // Save BNB balance before and after to know how much BNB to send the caller after swapping.
        uint tokensNeeded = IPancakeRouter02(pcsRouter).getAmountsIn(amountOut, path)[0];
        require(tokensNeeded <= amountInMax, 'CCM: NOT_ENOUGH_OUT_FOR_IN');
        IERC20(path[0]).transferFrom(msg.sender, address(this), tokensNeeded);
        amounts = _swapExactTokensForTokens(tokensNeeded, 0, path, to, deadline);
        uint ethToTransfer = amounts[amounts.length - 1];
        IWETH(WETH).withdraw(ethToTransfer);

        TransferHelper.safeTransferETH(to, ethToTransfer);
    }
    function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline)
        public
        virtual
        ensure(deadline)
        returns (uint[] memory amounts)
    {
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        amounts = _swapExactTokensForTokens(amountIn, amountOutMin, path, to, deadline);
        uint ethToTransfer = amounts[amounts.length - 1];
        IWETH(WETH).withdraw(ethToTransfer);
        // Now send to the caller.
        TransferHelper.safeTransferETH(to, ethToTransfer);
    }
    function swapETHForExactTokens(uint amountOut, address[] calldata path, address to, uint deadline)
        external
        virtual
        payable
        ensure(deadline)
        returns (uint[] memory amounts)
    {
        amounts = IPancakeRouter02(pcsRouter).getAmountsIn(amountOut, path);
        require(amounts[0] <= msg.value, 'PancakeRouter: EXCESSIVE_INPUT_AMOUNT');
        if (msg.value > amounts[0]) TransferHelper.safeTransferETH(msg.sender, msg.value - amounts[0]);
        IWETH(WETH).deposit{value: amounts[0]}();
        amounts = _swapExactTokensForTokens(amounts[0], 0, path, to, deadline);
        require(IERC20(path[path.length - 1]).transfer(to, amounts[amounts.length - 1]));
    }

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external ensure(deadline) virtual {
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        uint[] memory amounts = _swapExactTokensForTokens(amountIn, amountOutMin, path, address(this), deadline);
        uint tokensToSend = amounts[amounts.length - 1];
        require(tokensToSend >= amountOutMin, "CCM: LESS_OUT");
        require(IERC20(path[path.length - 1]).transfer(to, tokensToSend), "Final transfer failed");
    }


    function _authorizeUpgrade(address newImplementation) internal virtual override {
        require(msg.sender == owner(), "CCM: CANNOT_UPGRADE");
    }
}