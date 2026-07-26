// Minimal ABI for the deployed ForecastRegistry (see ../forecast-registry).
//
// The contract is emit-only: identity is the submitting wallet, a wallet
// describes itself with setAttribute(key, value), and forecasts are recorded
// with recordForecast / recordForecastBatch. Note marketId and outcome are
// plain `string` (no bytes32 packing), and odds are `uint32` basis points.

import { ethers } from "ethers";

export const FORECAST_REGISTRY_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "who", type: "address" },
      { indexed: true, internalType: "bytes32", name: "key", type: "bytes32" },
      { indexed: false, internalType: "string", name: "value", type: "string" },
    ],
    name: "AttributeSet",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "submitter",
        type: "address",
      },
      {
        indexed: true,
        internalType: "uint32",
        name: "platformId",
        type: "uint32",
      },
      {
        indexed: false,
        internalType: "string",
        name: "marketId",
        type: "string",
      },
      {
        indexed: false,
        internalType: "string",
        name: "outcome",
        type: "string",
      },
      { indexed: false, internalType: "uint32", name: "odds", type: "uint32" },
    ],
    name: "ForecastRecorded",
    type: "event",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "key", type: "bytes32" },
      { internalType: "string", name: "value", type: "string" },
    ],
    name: "setAttribute",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32[]", name: "keys", type: "bytes32[]" },
      { internalType: "string[]", name: "values", type: "string[]" },
    ],
    name: "setAttributes",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint32", name: "platformId", type: "uint32" },
      { internalType: "string", name: "marketId", type: "string" },
      { internalType: "string", name: "outcome", type: "string" },
      { internalType: "uint32", name: "odds", type: "uint32" },
    ],
    name: "recordForecast",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint32[]", name: "platformIds", type: "uint32[]" },
      { internalType: "string[]", name: "marketIds", type: "string[]" },
      { internalType: "string[]", name: "outcomes", type: "string[]" },
      { internalType: "uint32[]", name: "oddsList", type: "uint32[]" },
    ],
    name: "recordForecastBatch",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

// Attribute keys are keccak256 of the key name, e.g. K("forecastingModel").
export const attributeKey = (name: string): string =>
  ethers.keccak256(ethers.toUtf8Bytes(name));

// Odds are basis points: round(probability * 10000), clamped to [0, 10000].
export const toBasisPoints = (probability: number): number => {
  const bps = Math.round(probability * 10000);
  return Math.max(0, Math.min(10000, bps));
};
