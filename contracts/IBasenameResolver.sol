// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockBasenameResolver {
    mapping(bytes32 => address) private resolvedAddresses;
    mapping(address => string) public basenames;

    function namehash(bytes32 node) external pure returns (bytes32) {
        return node;
    }

    function resolve(bytes32 node) external view returns (address) {
        return resolvedAddresses[node];
    }

    function resolve(address wallet) external view returns (string memory) {
        return basenames[wallet];
    }

    function setResolvedAddress(bytes32 node, address addr) external {
        resolvedAddresses[node] = addr;
    }

    function setBasename(address wallet, string memory basename) external {
        basenames[wallet] = basename;
    }

    
}