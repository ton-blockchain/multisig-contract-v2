export abstract class Op {
    static readonly multisig = {
        new_order : 0x1,
        execute: 0x2,
        execute_internal: 0x3
    }
    static readonly order = {
        approve: 0x8,
        expired: 0x6,
        approve_rejected : 0x7,
        approved: 0x9,
        init: 0x5
    }
    static readonly actions = {
        send_message: 10,
        update_multisig_params: 11,
    }
}

export abstract class Errors {
    static readonly multisig = {
        unauthorized_new_order : 1007,
        invalid_new_order : 1008,
        not_enough_ton : 100,
        unauthorized_execute : 101,
        singers_outdated : 102,
        invalid_dictionary_sequence: 103,
        expired: 111
    }
    static readonly order = {
        unauthorized_init : 104,
        already_approved : 107,
        already_inited : 105,
        unauthorized_sign : 106,
        expired: 111,
        already_executed: 112
    }
};

export abstract class Params {
    static readonly bitsize = {
       op : 32,
       queryId : 64,
       orderSeqno : 256,
       signerIndex : 8,
       actionIndex : 8,
       time: 48
    }
}
