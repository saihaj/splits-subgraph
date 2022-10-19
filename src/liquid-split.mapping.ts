import { Address, BigInt, log } from "@graphprotocol/graph-ts";
import { CreateLS1155, CreateLS1155Clone } from "../generated/LiquidSplitFactory/LiquidSplitFactory";
import {
  CreateLiquidSplit,
  TransferSingle,
  FullLiquidSplit as LiquidSplitContract,
  TransferBatch,
  Transfer
} from "../generated/LiquidSplit/FullLiquidSplit";
import { LiquidSplit as LiquidSplitTemplate } from '../generated/templates'
import {
  LiquidSplit,
  Holder,
  User,
  CreateLiquidSplitEvent,
  LiquidSplitNFTTransferEvent,
  LiquidSplitNFTAddedEvent,
  LiquidSplitNFTRemovedEvent
} from "../generated/schema";
import { ADDED_PREFIX, createJointId, createTransactionIfMissing, createUserIfMissing, getLiquidSplit, PERCENTAGE_SCALE, REMOVED_PREFIX, ZERO_ADDRESS } from "./helpers";

const FACTORY_GENERATED_TOTAL_SUPPLY = BigInt.fromI64(1e3 as i64);
const CREATE_LIQUID_SPLIT_EVENT_PREFIX = "clse";
const TRANSFER_NFT_EVENT_PREFIX = "tne";

export function handleCreateLiquidSplit(event: CreateLiquidSplit): void {
  let isFactoryGenerated = false;
  handleLiquidSplitCreation(
    event.address,
    isFactoryGenerated,
    event.block.timestamp,
    event.transaction.hash.toHexString(),
    event.logIndex,
    event.block.number.toI32()
  );
}

export function handleCreateLiquidSplitClone(event: CreateLS1155Clone): void {
  let isFactoryGenerated = true;
  handleLiquidSplitCreation(
    event.params.ls,
    isFactoryGenerated,
    event.block.timestamp,
    event.transaction.hash.toHexString(),
    event.logIndex,
    event.block.number.toI32()
  );
}

export function handleCreateLiquidSplitFromFactory(event: CreateLS1155): void {
  // The liquid split was already created from the abstract constructor's event,
  // just need to mark it as factory generated
  let liquidSplitId = event.params.ls.toHexString();
  let liquidSplit = getLiquidSplit(liquidSplitId);
  if (!liquidSplit) return;

  liquidSplit.isFactoryGenerated = true;
  liquidSplit.save();
}

export function handleTransferSingle1155(event: TransferSingle): void {
  let liquidSplitId = event.address.toHexString();

  let liquidSplit = getLiquidSplit(liquidSplitId);
  if (!liquidSplit) return;

  let fromAddressString = event.params.from.toHexString();
  let toAddressString = event.params.to.toHexString();
  if (liquidSplit.isFactoryGenerated) {
    if (fromAddressString != ZERO_ADDRESS) {
      let fromHolder = getHolder(fromAddressString, liquidSplitId);
      fromHolder.ownership -= event.params.amount * PERCENTAGE_SCALE / FACTORY_GENERATED_TOTAL_SUPPLY;
      fromHolder.save();
    }
    if (toAddressString != ZERO_ADDRESS) {
      let toHolder = getHolder(toAddressString, liquidSplitId);
      toHolder.ownership += event.params.amount * PERCENTAGE_SCALE / FACTORY_GENERATED_TOTAL_SUPPLY;
      toHolder.save();
    }
  } else {
    updateHolderOwnershipNonFactoryLiquidSplit(event.address, event.params.from, event.params.to);
  }

  // Save event
  saveTransferEvents(
    liquidSplitId,
    fromAddressString,
    toAddressString,
    event.params.amount,
    event.block.timestamp,
    event.transaction.hash.toHexString(),
    event.logIndex
  );
}

export function handleTransferBatch1155(event: TransferBatch): void {
  let liquidSplitId = event.address.toHexString();

  let liquidSplit = getLiquidSplit(liquidSplitId);
  if (!liquidSplit) return;

  let fromAddressString = event.params.from.toHexString();
  let toAddressString = event.params.to.toHexString();
  let totalAmount = BigInt.fromI64(0);
  for (let i: i32 = 0; i < event.params.amounts.length; i++) {
    totalAmount += event.params.amounts[i];
  }

  if (liquidSplit.isFactoryGenerated) {
    if (fromAddressString != ZERO_ADDRESS) {
      let fromHolder = getHolder(fromAddressString, liquidSplitId);
      fromHolder.ownership -= totalAmount * PERCENTAGE_SCALE / FACTORY_GENERATED_TOTAL_SUPPLY;
      fromHolder.save();
    }
    if (toAddressString != ZERO_ADDRESS) {
      let toHolder = getHolder(toAddressString, liquidSplitId);
      toHolder.ownership += totalAmount * PERCENTAGE_SCALE / FACTORY_GENERATED_TOTAL_SUPPLY;
      toHolder.save();
    }
  } else {
    updateHolderOwnershipNonFactoryLiquidSplit(event.address, event.params.from, event.params.to);
  }

  // Save event
  saveTransferEvents(
    liquidSplitId,
    fromAddressString,
    toAddressString,
    totalAmount,
    event.block.timestamp,
    event.transaction.hash.toHexString(),
    event.logIndex
  );
}

export function handleTransfer721(event: Transfer): void {
  let liquidSplitId = event.address.toHexString();

  let liquidSplit = getLiquidSplit(liquidSplitId);
  if (!liquidSplit) return;

  updateHolderOwnershipNonFactoryLiquidSplit(event.address, event.params.from, event.params.to);
}

function handleLiquidSplitCreation(
  liquidSplitAddress: Address,
  isFactoryGenerated: boolean,
  timestamp: BigInt,
  txHash: string,
  logIdx: BigInt,
  blockNumber: i32
): void {
  let liquidSplitId = liquidSplitAddress.toHexString();
  createTransactionIfMissing(txHash);

  // If a user already exists at this id, just return for now. Cannot have two
  // entities with the same id if they share an interface. Will handle this situation
  // in subgraph v2.
  let liquidSplitUser = User.load(liquidSplitId);
  if (liquidSplitUser) {
    log.warning('Trying to create a liquid split, but a user already exists: {}', [liquidSplitId]);
    return;
  }

  let liquidSplit = new LiquidSplit(liquidSplitId);
  liquidSplit.latestBlock = blockNumber;
  liquidSplit.isFactoryGenerated = isFactoryGenerated;

  // Fetch distributor fee and payout split
  let liquidSplitContract = LiquidSplitContract.bind(liquidSplitAddress);
  liquidSplit.distributorFee = liquidSplitContract.distributorFee();
  liquidSplit.split = liquidSplitContract.payoutSplit().toHexString();

  liquidSplit.save();
  LiquidSplitTemplate.create(liquidSplitAddress);

  // Save event
  let createLiquidSplitEventId = createJointId([CREATE_LIQUID_SPLIT_EVENT_PREFIX, txHash, logIdx.toString()]);
  let createLiquidSplitEvent = new CreateLiquidSplitEvent(createLiquidSplitEventId);
  createLiquidSplitEvent.timestamp = timestamp;
  createLiquidSplitEvent.transaction = txHash;
  createLiquidSplitEvent.account = liquidSplitId;
  createLiquidSplitEvent.logIndex = logIdx;
  createLiquidSplitEvent.save();
}

function getHolder(accountId: string, liquidSplitId: string): Holder {
  let holderId = createJointId([liquidSplitId, accountId]);
  let holder = Holder.load(holderId);
  if (!holder) {
    createUserIfMissing(accountId);
    holder = new Holder(holderId);
    holder.liquidSplit = liquidSplitId;
    holder.account = accountId;
    holder.ownership = BigInt.fromI64(0);
  }
  
  return holder;
}

function updateHolderOwnershipNonFactoryLiquidSplit(liquidSplitAddress: Address, fromAddress: Address, toAddress: Address): void {
  let liquidSplitContract = LiquidSplitContract.bind(liquidSplitAddress);
  let liquidSplitId = liquidSplitAddress.toHexString();

  let fromAddressString = fromAddress.toHexString();
  if (fromAddressString != ZERO_ADDRESS) {
    let fromHolder = getHolder(fromAddressString, liquidSplitId);
    fromHolder.ownership = liquidSplitContract.scaledPercentBalanceOf(fromAddress);
    fromHolder.save();
  }

  let toAddressString = toAddress.toHexString();
  if (toAddressString != ZERO_ADDRESS) {
    let toHolder = getHolder(toAddressString, liquidSplitId);
    toHolder.ownership = liquidSplitContract.scaledPercentBalanceOf(toAddress);
    toHolder.save();
  }
}

function saveTransferEvents(
  liquidSplitId: string,
  fromAddress: string,
  toAddress: string,
  amount: BigInt | null,
  timestamp: BigInt,
  txHash: string,
  logIdx: BigInt
): void {
  createTransactionIfMissing(txHash);

  let nftTransferEventId = createJointId([TRANSFER_NFT_EVENT_PREFIX, txHash, logIdx.toString()]);
  let nftTransferEvent = new LiquidSplitNFTTransferEvent(nftTransferEventId);
  nftTransferEvent.timestamp = timestamp;
  nftTransferEvent.transaction = txHash;
  nftTransferEvent.account = liquidSplitId;
  nftTransferEvent.logIndex = logIdx;
  nftTransferEvent.transferType = getTransferType(fromAddress, toAddress);
  if (amount) {
    nftTransferEvent.amount = amount;
  }
  nftTransferEvent.save();

  if (toAddress != ZERO_ADDRESS) {
    let nftAddedEventId = createJointId([ADDED_PREFIX, nftTransferEventId]);
    let nftAddedEvent = new LiquidSplitNFTAddedEvent(nftAddedEventId);
    nftAddedEvent.timestamp = timestamp;
    nftAddedEvent.account = toAddress;
    nftAddedEvent.logIndex = logIdx;
    nftAddedEvent.nftTransferEvent = nftTransferEventId;
    nftAddedEvent.save();
  }

  if (fromAddress != ZERO_ADDRESS) {
    let nftRemovedEventId = createJointId([REMOVED_PREFIX, nftTransferEventId]);
    let nftRemovedEvent = new LiquidSplitNFTRemovedEvent(nftRemovedEventId);
    nftRemovedEvent.timestamp = timestamp;
    nftRemovedEvent.account = fromAddress;
    nftRemovedEvent.logIndex = logIdx;
    nftRemovedEvent.nftTransferEvent = nftTransferEventId;
    nftRemovedEvent.save();
  }
}

function getTransferType(fromAddress: string, toAddress: string): string {
  if (fromAddress == ZERO_ADDRESS) {
    return 'mint'
  }
  if (toAddress === ZERO_ADDRESS) {
    return 'burn'
  }

  return 'transfer'
}
