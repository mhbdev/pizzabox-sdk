import {Address, address, beginCell, Cell, Dictionary, toNano, TupleReader} from "@ton/core";
import {sha256_sync} from "@ton/crypto";
import {Api, TonApiClient} from "@ton-api/client";

const sha256 = (str: string) => {
    return Buffer.from(sha256_sync(str));
};

const toKey = (key: string) => {
    return BigInt(`0x${sha256(key).toString('hex')}`);
};

function buildOnChainMetadata(data: any): Cell {
    let dict = Dictionary.empty(
        Dictionary.Keys.BigUint(256),
        Dictionary.Values.Cell()
    );
    Object.entries(data).forEach(([key, value]) => {
        if (typeof (value) === "number") {
            dict.set(toKey(key), beginCell().storeUint(0, 8).storeUint(value, 8).endCell());
        } else {
            dict.set(toKey(key), beginCell().storeUint(0, 8).storeStringTail(value as string).endCell());
        }
    });

    return beginCell()
        .storeInt(0x00, 8)
        .storeDict(dict)
        .endCell();
}

class PizzaBox {
    private static readonly lockerFactory = address("EQA2apWqdiZiyJhnYDc-kjEWlMprUurkqqRfDQ3Sx-gdcImu");
    private static readonly gasConstants = {
        lock: {
            gasAmount: toNano(0.75),
            forwardGasAmount: toNano(0.645),
        },
        unlock: {
            gasAmount: toNano(0.05)
        }
    }
    private static tonApiHttp?: TonApiClient;

    constructor({tonApiHttp}: { tonApiHttp?: TonApiClient }) {
        PizzaBox.tonApiHttp = tonApiHttp;
    }

    /// `lockUntil` - The epoch UTC time in seconds
    /// `firstUnlockPercent` - a number between 0-100
    public static async getLockTxParams(jettonMaster: Address,
                                        jettonAmountToLock: bigint,
                                        userJettonWallet: Address,
                                        userWalletAddress: Address,
                                        lockProps: {
                                            lockPurpose?: string,
                                            lockUntil: number,
                                            firstUnlockPercent: number,
                                            vesting?: {
                                                cycleNumber: number,
                                                cycleLength: number,
                                            }

                                        }) {
        if (lockProps.firstUnlockPercent > 100 || lockProps.firstUnlockPercent < 0) {
            throw Error('Invalid `firstUnlockPercent`');
        }

        let cyclesNumber = 0;
        let cyclesLength = 0;
        if (lockProps.firstUnlockPercent != 100) {
            if (lockProps.vesting) {
                cyclesNumber = lockProps.vesting.cycleNumber;
                cyclesLength = Math.ceil(lockProps.vesting.cycleLength) * 24 * 60 * 60;
            } else {
                throw Error('Vesting details missed!');
            }
        }

        const api = new Api(PizzaBox.tonApiHttp ?? new TonApiClient({
            baseUrl: 'https://tonapi.io',
        }));

        const jettonInfo = await api.jettons.getJettonInfo(jettonMaster);

        const deployVestingPayload = beginCell()
            .storeAddress(jettonMaster)
            .storeAddress(userWalletAddress)
            .storeUint(lockProps.lockUntil, 32)
            .storeUint(Math.floor(lockProps.firstUnlockPercent * 1000000), 32)
            .storeUint(cyclesLength, 32)
            .storeUint(cyclesNumber, 32)
            .storeMaybeRef(buildOnChainMetadata({
                purpose: lockProps.lockPurpose,
                decimals: jettonInfo.metadata.decimals,
                symbol: jettonInfo.metadata.symbol,
                image: 'https://api.pizzaton.me/launchpad/vesting/img/',
                uri: 'https://api.pizzaton.me/launchpad/vesting/meta/'
            }))
            .endCell();

        const jettonTransferBody = beginCell()
            .storeUint(0xf8a7ea5, 32)
            .storeUint(0, 64)
            .storeCoins(jettonAmountToLock)
            .storeAddress(PizzaBox.lockerFactory)
            .storeAddress(userWalletAddress)
            .storeMaybeRef(null)
            .storeCoins(PizzaBox.gasConstants.lock.forwardGasAmount) // forward ton amount
            .storeMaybeRef(deployVestingPayload)
            .endCell();

        return {
            dest: userJettonWallet,
            amount: PizzaBox.gasConstants.lock.gasAmount,
            payload: jettonTransferBody.toBoc(),
        }
    }

    public static getUnlockTxParams(lockRecordSBT: Address) {
        return {
            dest: lockRecordSBT,
            amount: PizzaBox.gasConstants.unlock.gasAmount,
            payload: beginCell()
                .storeUint(0xa769de27, 32)
                .storeUint(0, 64)
                .endCell().toBoc(),
        }
    }

    public static async getLockDetails(lockRecordSBT: Address) {
        const api = new Api(PizzaBox.tonApiHttp ?? new TonApiClient({
            baseUrl: 'https://tonapi.io',
        }));

        const result = await api.blockchain.execGetMethodForBlockchainAccount(lockRecordSBT, 'get_storage_data');
        const stack = new TupleReader(result.stack);
        const init = stack.readBoolean();
        if (init) {
            return {
                type: "inited",
                factoryAddress: stack.readAddress(),
                index: stack.readBigNumber(),
                ownerAddress: stack.readAddress(),
                jettonMinterAddress: stack.readAddress(),
                jettonWalletAddress: stack.readAddressOpt(),
                content: stack.readCellOpt(),
                factoryJettonWallet: stack.readAddress(),
                lockedJettons: stack.readBigNumber(),
                jettonsLocked: stack.readBoolean(),
                claimedTimes: stack.readNumber(),
                claimedJettons: stack.readBigNumber(),
                firstUnlockTime: stack.readNumber(),
                firstUnlockSize: stack.readNumber(),
                cycleLength: stack.readNumber(),
                cyclesNumber: stack.readNumber()
            }
        } else {
            return {
                type: "uninit",
                factoryAddress: stack.readAddress(),
                index: stack.readBigNumber()
            }
        }
    }
}

export {PizzaBox};