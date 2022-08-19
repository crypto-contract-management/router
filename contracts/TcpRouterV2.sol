// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "./IPancakeRouter.sol";
import "./IPancakePair.sol";
import "./TaxableRouter.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";


library PancakeLibrary {
    using SafeMath for uint;

    // returns sorted token addresses, used to handle return values from pairs sorted in this order
    function sortTokens(address tokenA, address tokenB) internal pure returns (address token0, address token1) {
        require(tokenA != tokenB, 'PancakeLibrary: IDENTICAL_ADDRESSES');
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), 'PancakeLibrary: ZERO_ADDRESS');
    }

    // calculates the CREATE2 address for a pair without making any external calls
    function pairFor(address factory, address tokenA, address tokenB) internal pure returns (address pair) {
        (address token0, address token1) = sortTokens(tokenA, tokenB);
        pair = address(uint160(uint256((keccak256(abi.encodePacked(
                hex'ff',
                factory,
                keccak256(abi.encodePacked(token0, token1)),
                hex'3007386e5baf337bee9f8e7466afcf6fa4cfd0c68c638594d9bf7ba57880717c' // TODO: FIX BEFORE DEPLOY
            ))))));
    }

    // fetches and sorts the reserves for a pair
    function getReserves(address factory, address tokenA, address tokenB) internal view returns (uint reserveA, uint reserveB) {
        (address token0,) = sortTokens(tokenA, tokenB);
        pairFor(factory, tokenA, tokenB);
        (uint reserve0, uint reserve1,) = IPancakePair(pairFor(factory, tokenA, tokenB)).getReserves();
        (reserveA, reserveB) = tokenA == token0 ? (reserve0, reserve1) : (reserve1, reserve0);
    }

    // given some amount of an asset and pair reserves, returns an equivalent amount of the other asset
    function quote(uint amountA, uint reserveA, uint reserveB) internal pure returns (uint amountB) {
        require(amountA > 0, 'PancakeLibrary: INSUFFICIENT_AMOUNT');
        require(reserveA > 0 && reserveB > 0, 'PancakeLibrary: INSUFFICIENT_LIQUIDITY');
        amountB = amountA.mul(reserveB) / reserveA;
    }

    // given an input amount of an asset and pair reserves, returns the maximum output amount of the other asset
    function getAmountOut(uint amountIn, uint reserveIn, uint reserveOut) internal pure returns (uint amountOut) {
        require(amountIn > 0, 'PancakeLibrary: INSUFFICIENT_INPUT_AMOUNT');
        require(reserveIn > 0 && reserveOut > 0, 'PancakeLibrary: INSUFFICIENT_LIQUIDITY');
        uint amountInWithFee = amountIn.mul(9975);
        uint numerator = amountInWithFee.mul(reserveOut);
        uint denominator = reserveIn.mul(10000).add(amountInWithFee);
        amountOut = numerator / denominator;
    }

    // given an output amount of an asset and pair reserves, returns a required input amount of the other asset
    function getAmountIn(uint amountOut, uint reserveIn, uint reserveOut) internal pure returns (uint amountIn) {
        require(amountOut > 0, 'PancakeLibrary: INSUFFICIENT_OUTPUT_AMOUNT');
        require(reserveIn > 0 && reserveOut > 0, 'PancakeLibrary: INSUFFICIENT_LIQUIDITY');
        uint numerator = reserveIn.mul(amountOut).mul(10000);
        uint denominator = reserveOut.sub(amountOut).mul(9975);
        amountIn = (numerator / denominator).add(1);
    }

    // performs chained getAmountOut calculations on any number of pairs
    function getAmountsOut(address factory, uint amountIn, address[] memory path) internal view returns (uint[] memory amounts) {
        require(path.length >= 2, 'PancakeLibrary: INVALID_PATH');
        amounts = new uint[](path.length);
        amounts[0] = amountIn;
        for (uint i; i < path.length - 1; i++) {
            (uint reserveIn, uint reserveOut) = getReserves(factory, path[i], path[i + 1]);
            amounts[i + 1] = getAmountOut(amounts[i], reserveIn, reserveOut);
        }
    }

    // performs chained getAmountIn calculations on any number of pairs
    function getAmountsIn(address factory, uint amountOut, address[] memory path) internal view returns (uint[] memory amounts) {
        require(path.length >= 2, 'PancakeLibrary: INVALID_PATH');
        amounts = new uint[](path.length);
        amounts[amounts.length - 1] = amountOut;
        for (uint i = path.length - 1; i > 0; i--) {
            (uint reserveIn, uint reserveOut) = getReserves(factory, path[i - 1], path[i]);
            amounts[i - 1] = getAmountIn(amounts[i], reserveIn, reserveOut);
        }
    }
}

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

contract TcpRouterV2 is IPancakeRouter02, TaxableRouter, UUPSUpgradeable {
    using SafeMath for uint;

    address public pcsRouter;
    address public factory;
    address public WETH;

    modifier ensure(uint deadline) {
        require(deadline >= block.timestamp, 'PancakeRouter: EXPIRED');
        _;
    }

    function initialize(address _pcsRouter, address _pcsFactory, address _weth) initializer public {
        TaxableRouter.initialize();
        pcsRouter = _pcsRouter;
        WETH = _weth;
        factory = _pcsFactory;
    }

    receive() external payable { }

    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external virtual override ensure(deadline) returns (uint[] memory amounts) {
        require(false, "Coming soon");
    }
    function swapTokensForExactTokens(
        uint amountOut,
        uint amountInMax,
        address[] calldata path,
        address to,
        uint deadline
    ) external virtual override ensure(deadline) returns (uint[] memory amounts) {
       require(false, "Coming soon");
    }
    function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline)
        external
        virtual
        override
        payable
        ensure(deadline)
        returns (uint[] memory amounts)
    {
        // We only work with taxes between direct pairs of WETH <=> Token for now.
        address weth = path[0];
        address tokenToSwap = path[1];
        uint ethToSend = takeETHInTax(tokenToSwap, msg.value) - 1 ether;
        // Swap tokens and send to this router.
        amounts = IPancakeRouter02(pcsRouter).swapExactETHForTokens{value: ethToSend}(amountOutMin, path, address(this), deadline);
        require(IERC20(tokenToSwap).transfer(to, amounts[amounts.length - 1]), "Final transfer failed");
    }
    function swapTokensForExactETH(uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline)
        external
        virtual
        override
        ensure(deadline)
        returns (uint[] memory amounts)
    {
        address tokenToSwap = path[0];
        address weth = path[path.length - 1];
        assert(weth == WETH);
        // Transfer tokens from caller to this router and then swap these tokens via PCS.
        // Save BNB balance before and after to know how much BNB to send the caller after swapping.
        uint tokensNeeded = PancakeLibrary.getAmountsIn(factory, amountOut, path)[0];
        require(tokensNeeded <= amountInMax, 'TCP: NOT_ENOUGH_OUT_FOR_IN');
        TransferHelper.safeTransferFrom(
            tokenToSwap, msg.sender, address(this), tokensNeeded
        );
        IERC20(tokenToSwap).approve(pcsRouter, tokensNeeded);
        
        amounts = IPancakeRouter02(pcsRouter).swapTokensForExactETH(amountOut, amountInMax, path, address(this), deadline);
        // The caller does not receive 100% of the ETH gained, the fees are subtracted before.
        uint ethToTransfer = takeETHOutTax(tokenToSwap, amounts[amounts.length - 1]) - 2 ether;
        // Now send to the caller.
        TransferHelper.safeTransferETH(to, ethToTransfer);
    }
    function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline)
        external
        virtual
        override
        ensure(deadline)
        returns (uint[] memory amounts)
    {
        address tokenToSwap = path[0];
        address weth = path[path.length - 1];
        assert(weth == WETH);
        // Transfer tokens from caller to this router and then swap these tokens via PCS.
        // Save BNB balance before and after to know how much BNB to send the caller after swapping.
        IERC20(tokenToSwap).transferFrom(to, address(this), amountIn);
        IERC20(tokenToSwap).approve(pcsRouter, amountIn);

        amounts = IPancakeRouter02(pcsRouter).swapExactTokensForETH(amountIn, amountOutMin, path, address(this), deadline);

        // The caller does not receive 100% of the ETH gained, the fees are subtracted before.
        uint ethToTransfer = takeETHOutTax(tokenToSwap, amounts[amounts.length - 1]) - 3 ether;
        // Now send to the caller.
        TransferHelper.safeTransferETH(to, ethToTransfer);
    }
    function swapETHForExactTokens(uint amountOut, address[] calldata path, address to, uint deadline)
        external
        virtual
        override
        payable
        ensure(deadline)
        returns (uint[] memory amounts)
    {
        // We only work with taxes between direct pairs of WETH <=> Token for now.
        address weth = path[0];
        address tokenToSwap = path[1];
        uint ethToSend = takeETHInTax(tokenToSwap, msg.value) - 4 ether;
        // Swap tokens and send to this router.
        amounts = IPancakeRouter02(pcsRouter).swapETHForExactTokens{value: ethToSend}(amountOut, path, address(this), deadline);
        require(IERC20(tokenToSwap).transfer(to, amounts[amounts.length - 1]), "Final transfer failed");
    }

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external virtual override ensure(deadline) {
        require(false, "Coming soon");
    }
    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    )
        external
        virtual
        override
        payable
        ensure(deadline)
    {
                // We only work with taxes between direct pairs of WETH <=> Token for now.
        address weth = path[0];
        address tokenToSwap = path[1];
        uint ethToSend = takeETHInTax(tokenToSwap, msg.value);
        // Swap tokens and send to this router.
        uint balanceBefore = IERC20(tokenToSwap).balanceOf(address(this));
        IPancakeRouter02(pcsRouter).swapExactETHForTokensSupportingFeeOnTransferTokens{value: ethToSend}(amountOutMin, path, address(this), deadline);
        uint balanceAfter = IERC20(tokenToSwap).balanceOf(address(this));
        require(IERC20(tokenToSwap).transfer(to, balanceAfter.sub(balanceBefore)), "Final transfer failed");
       
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
        override
        ensure(deadline)
    {
        address tokenToSwap = path[0];
        address weth = path[path.length - 1];
        assert(weth == WETH);
        // Transfer tokens from caller to this router and then swap these tokens via PCS.
        // Save BNB balance before and after to know how much BNB to send the caller after swapping.
        IERC20(tokenToSwap).transferFrom(to, address(this), amountIn);
        IERC20(tokenToSwap).approve(pcsRouter, amountIn);

        uint balanceBefore = address(this).balance;
        IPancakeRouter02(pcsRouter).swapExactTokensForETHSupportingFeeOnTransferTokens(amountIn, amountOutMin, path, address(this), deadline);
        uint reward = address(this).balance.sub(balanceBefore);

        // The caller does not receive 100% of the ETH gained, the fees are subtracted before.
        uint ethToTransfer = takeETHOutTax(tokenToSwap, reward);
        // Now send to the caller.
        TransferHelper.safeTransferETH(to, ethToTransfer);
    }

    // All the following functions are pure proxy functions.
    // The only reason we kept them is that people can connect to our router
    // and leave the rest of their code unchainged as we implement the same interface
    // as the originial pancakeswap router does.
     function addLiquidity(
        address tokenA,
        address tokenB,
        uint amountADesired,
        uint amountBDesired,
        uint amountAMin,
        uint amountBMin,
        address to,
        uint deadline
    ) external virtual override ensure(deadline) returns (uint amountA, uint amountB, uint liquidity) {
        return IPancakeRouter02(pcsRouter).addLiquidity(tokenA, tokenB, amountADesired, amountBDesired, amountAMin, amountBMin, to, deadline);
    }
    function addLiquidityETH(
        address token,
        uint amountTokenDesired,
        uint amountTokenMin,
        uint amountETHMin,
        address to,
        uint deadline
    ) external virtual override payable ensure(deadline) returns (uint amountToken, uint amountETH, uint liquidity) {
       return IPancakeRouter02(pcsRouter).addLiquidityETH(token, amountTokenDesired, amountTokenMin, amountETHMin, to, deadline);
    }

    function removeLiquidity(
        address tokenA,
        address tokenB,
        uint liquidity,
        uint amountAMin,
        uint amountBMin,
        address to,
        uint deadline
    ) public virtual override ensure(deadline) returns (uint amountA, uint amountB) {
       return IPancakeRouter02(pcsRouter).removeLiquidity(tokenA, tokenB, liquidity, amountAMin, amountBMin, to, deadline);
    }
    function removeLiquidityETH(
        address token,
        uint liquidity,
        uint amountTokenMin,
        uint amountETHMin,
        address to,
        uint deadline
    ) public virtual override ensure(deadline) returns (uint amountToken, uint amountETH) {
        return IPancakeRouter02(pcsRouter).removeLiquidityETH(token, liquidity, amountTokenMin, amountETHMin, to, deadline);
    }
    function removeLiquidityWithPermit(
        address tokenA,
        address tokenB,
        uint liquidity,
        uint amountAMin,
        uint amountBMin,
        address to,
        uint deadline,
        bool approveMax, uint8 v, bytes32 r, bytes32 s
    ) external virtual override returns (uint amountA, uint amountB) {
       return IPancakeRouter02(pcsRouter).removeLiquidityWithPermit(tokenA, tokenB, liquidity, amountAMin, amountBMin, to, deadline, approveMax, v, r, s);
    }
    function removeLiquidityETHWithPermit(
        address token,
        uint liquidity,
        uint amountTokenMin,
        uint amountETHMin,
        address to,
        uint deadline,
        bool approveMax, uint8 v, bytes32 r, bytes32 s
    ) external virtual override returns (uint amountToken, uint amountETH) {
       return IPancakeRouter02(pcsRouter).removeLiquidityETHWithPermit(token, liquidity, amountTokenMin, amountETHMin, to, deadline, approveMax, v, r, s);
    }

    function removeLiquidityETHSupportingFeeOnTransferTokens(
        address token,
        uint liquidity,
        uint amountTokenMin,
        uint amountETHMin,
        address to,
        uint deadline
    ) public virtual override ensure(deadline) returns (uint amountETH) {
       return IPancakeRouter02(pcsRouter).removeLiquidityETHSupportingFeeOnTransferTokens(token, liquidity, amountTokenMin, amountETHMin, to, deadline);
    }
    function removeLiquidityETHWithPermitSupportingFeeOnTransferTokens(
        address token,
        uint liquidity,
        uint amountTokenMin,
        uint amountETHMin,
        address to,
        uint deadline,
        bool approveMax, uint8 v, bytes32 r, bytes32 s
    ) external virtual override returns (uint amountETH) {
       return IPancakeRouter02(pcsRouter).removeLiquidityETHWithPermitSupportingFeeOnTransferTokens(token, liquidity, amountTokenMin, amountETHMin, to, deadline, approveMax, v, r, s);
    }
    

    function quote(uint amountA, uint reserveA, uint reserveB) 
        public
        view 
        virtual 
        override 
        returns (uint amountB) {
            amountB = IPancakeRouter02(pcsRouter).quote(amountA, reserveA, reserveB);
    }

    function getAmountOut(uint amountIn, uint reserveIn, uint reserveOut)
        public
        view
        virtual
        override
        returns (uint amountOut) {
            amountOut =  IPancakeRouter02(pcsRouter).getAmountOut(amountIn, reserveIn, reserveOut);
    }

    function getAmountIn(uint amountOut, uint reserveIn, uint reserveOut)
        public
        view
        virtual
        override
        returns (uint amountIn) {
            amountIn = IPancakeRouter02(pcsRouter).getAmountIn(amountOut, reserveIn, reserveOut);
    }

    function getAmountsOut(uint amountIn, address[] memory path)
        public
        view
        virtual
        override
        returns (uint[] memory amounts) {
            amounts = IPancakeRouter02(pcsRouter).getAmountsOut(amountIn, path);
    }

    function getAmountsIn(uint amountOut, address[] memory path)
        public
        view
        virtual
        override
        returns (uint[] memory amounts) {
            amounts = IPancakeRouter02(pcsRouter).getAmountsIn(amountOut, path);
    }

    function _authorizeUpgrade(address newImplementation) internal virtual override {
        require(true, "CCM: CANNOT_UPGRADE");
    }
}