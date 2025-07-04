import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import algosdk from 'algosdk';
import crypto from 'crypto';
import seedWalletService from './services/seedWalletService.js';
import { sendEmailNotification, isValidPicaConfig } from '../utils/emailService.js';

const app = express();
const PORT = 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Network configurations
const NETWORK_CONFIGS = {
  testnet: {
    name: 'TestNet',
    algodToken: '',
    algodServer: 'https://testnet-api.4160.nodely.dev',
    algodPort: 443
  },
  mainnet: {
    name: 'MainNet',
    algodToken: '',
    algodServer: 'https://mainnet-api.4160.nodely.dev',
    algodPort: 443
  }
};

// Create Algorand client for specific network
function createAlgodClient(network = 'mainnet') {
  const config = NETWORK_CONFIGS[network];
  if (!config) {
    throw new Error(`Unsupported network: ${network}`);
  }
  
  return new algosdk.Algodv2(config.algodToken, config.algodServer, config.algodPort);
}

// Check if email service is configured
if (isValidPicaConfig) {
  console.log('✅ Resend email service configured');
} else {
  console.log('📧 Resend not configured - Email notifications will be simulated');
}

// In-memory storage for claim codes (in production, use a database)
const claimStorage = new Map();

// Generate secure random claim code
function generateClaimCode() {
  return crypto.randomBytes(16).toString('hex').toUpperCase();
}

// Hash claim code for smart contract
function hashClaimCode(code) {
  // Ensure we're working with consistent UTF-8 encoding
  return crypto.createHash('sha256').update(code, 'utf8').digest();
}

// Store claim information
function storeClaim(claimCode, claimData) {
  claimStorage.set(claimCode, {
    ...claimData,
    createdAt: new Date(),
    claimed: false
  });
}

// Get claim information
function getClaim(claimCode) {
  return claimStorage.get(claimCode);
}

// Mark claim as used
function markClaimAsUsed(claimCode) {
  const claim = claimStorage.get(claimCode);
  if (claim) {
    claim.claimed = true;
    claim.claimedAt = new Date();
    claimStorage.set(claimCode, claim);
  }
}

// Create TEAL contract for hash-based claiming with refund after 5 minutes (for testing)
function createHashClaimContractTeal(hashedClaimCode, senderAddress, amount) {
  const tealProgram = `#pragma version 6

// Branch on application lifecycle call
txn ApplicationID
int 0
==
bnz handle_creation

txn OnCompletion
int NoOp
==
bnz handle_noop

txn OnCompletion
int CloseOut
==
bnz handle_closeout

txn OnCompletion
int DeleteApplication
==
bnz handle_delete

// Default: reject
int 0
return

////////////////////////
// Handle App Creation
////////////////////////
handle_creation:
    // Store: hash, amount, sender, created, claimed = 0
    byte "hash"
    txna ApplicationArgs 1
    app_global_put

    byte "amount"
    txna ApplicationArgs 2
    btoi
    app_global_put

    byte "sender"
    txna ApplicationArgs 3
    app_global_put

    byte "created"
    global LatestTimestamp
    app_global_put

    byte "claimed"
    int 0
    app_global_put

    int 1
    return

////////////////////////
// Handle NoOp (claim or refund)
////////////////////////
handle_noop:
    txna ApplicationArgs 0
    byte "claim"
    ==
    bnz handle_claim

    txna ApplicationArgs 0
    byte "refund"
    ==
    bnz handle_refund

    int 0
    return

////////////////////////
// Secure Claim
////////////////////////
handle_claim:
    // Require: hash(plaintext_code) == stored hash AND not claimed
    txna ApplicationArgs 1
    sha256
    byte "hash"
    app_global_get
    ==
    assert

    byte "claimed"
    app_global_get
    int 0
    ==
    assert

    // Set claimed = 1
    byte "claimed"
    int 1
    app_global_put

    // Ensure contract has sufficient balance
    global CurrentApplicationAddress
    balance
    byte "amount"
    app_global_get
    >=
    assert

    // Send amount to caller (txn Sender)
    itxn_begin
    int pay
    itxn_field TypeEnum

    txn Sender
    itxn_field Receiver

    byte "amount"
    app_global_get
    itxn_field Amount

    int 1000
    itxn_field Fee

    txn Sender
    itxn_field CloseRemainderTo

    itxn_submit

    int 1
    return

////////////////////////
// Refund (after 5 minutes, if not claimed, by original sender)
////////////////////////
handle_refund:
    // Must be > 5 minutes since creation
    global LatestTimestamp
    byte "created"
    app_global_get
    -
    int 300
    >=
    assert

    // Must not already be claimed
    byte "claimed"
    app_global_get
    int 0
    ==
    assert

    // Must be original sender
    txn Sender
    byte "sender"
    app_global_get
    ==
    assert

    // Set claimed = 1
    byte "claimed"
    int 1
    app_global_put

    // Ensure contract has sufficient balance
    global CurrentApplicationAddress
    balance
    byte "amount"
    app_global_get
    >=
    assert

    // Refund sender
    itxn_begin
    int pay
    itxn_field TypeEnum

    byte "sender"
    app_global_get
    itxn_field Receiver

    byte "amount"
    app_global_get
    itxn_field Amount

    int 1000
    itxn_field Fee

    byte "sender"
    app_global_get
    itxn_field CloseRemainderTo

    itxn_submit

    int 1
    return

////////////////////////
// CloseOut Safety (only if balance is 0 and caller is sender)
////////////////////////
handle_closeout:
    txn Sender
    byte "sender"
    app_global_get
    ==
    assert

    global CurrentApplicationAddress
    balance
    int 10000  // Allow up to 0.01 ALGO remaining (for fees/minimum balance)
    <=
    assert

    int 1
    return

////////////////////////
// Delete Application (only if balance is minimal and caller is sender)
////////////////////////
handle_delete:
    txn Sender
    byte "sender"
    app_global_get
    ==
    assert

    global CurrentApplicationAddress
    balance
    int 10000  // Allow up to 0.01 ALGO remaining (for fees/minimum balance)
    <=
    assert

    int 1
    return`;

  return tealProgram;
}

// Compile TEAL program
async function compileTealProgram(tealSource, network = 'testnet') {
  try {
    const algodClient = createAlgodClient(network);
    
    // Test connection first
    await algodClient.status().do();
    
    const compileResponse = await algodClient.compile(tealSource).do();
    
    if (!compileResponse.result) {
      throw new Error('TEAL compilation failed - no result returned');
    }
    
    return {
      compiledProgram: new Uint8Array(Buffer.from(compileResponse.result, 'base64')),
      hash: compileResponse.hash
    };
  } catch (error) {
    console.error('Error compiling TEAL program:', error);
    throw new Error(`Failed to compile smart contract: ${error.message}`);
  }
}

// Validate Algorand address format
function validateAlgorandAddress(address) {
  if (!address || typeof address !== 'string') {
    throw new Error('Address must be a valid string');
  }
  
  const trimmedAddress = address.trim();
  if (!trimmedAddress) {
    throw new Error('Address cannot be empty');
  }
  
  // Use algosdk's built-in validation
  if (!algosdk.isValidAddress(trimmedAddress)) {
    throw new Error('Invalid Algorand address format');
  }
  
  // Additional validation by attempting to decode the address
  try {
    algosdk.decodeAddress(trimmedAddress);
  } catch (decodeError) {
    throw new Error(`Address validation failed: ${decodeError.message}`);
  }
  
  return trimmedAddress;
}

// Deploy smart contract to Algorand - clean single transaction
async function createSingleAppTransaction(compiledProgram, senderAddress, claimHash, amount, network = 'testnet') {
  try {
    console.log('🔍 Creating single app creation transaction');
    
    const validatedSenderAddress = validateAlgorandAddress(senderAddress);
    const algodClient = createAlgodClient(network);
    const suggestedParams = await algodClient.getTransactionParams().do();
    
    // Fix genesisHash if needed
    if (suggestedParams.genesisHash && !(suggestedParams.genesisHash instanceof Uint8Array)) {
      const hashArray = Object.values(suggestedParams.genesisHash);
      suggestedParams.genesisHash = new Uint8Array(hashArray);
    }

    // Create clear program
    const clearProgram = new Uint8Array([0x06, 0x81, 0x01]);
    
    // Prepare application arguments
    const appArgs = [
      new TextEncoder().encode('setup'),
      claimHash,
      algosdk.encodeUint64(Math.floor(amount * 1000000)),
      algosdk.decodeAddress(validatedSenderAddress).publicKey
    ];

    // Single Transaction: Application Creation
    const appCreateParams = { ...suggestedParams, fee: 1000, flatFee: true };
    const appCreateTxn = algosdk.makeApplicationCreateTxnFromObject({
      sender: validatedSenderAddress,
      suggestedParams: appCreateParams,
      onComplete: algosdk.OnApplicationComplete.NoOpOC,
      approvalProgram: compiledProgram,
      clearProgram: clearProgram,
      numLocalInts: 0,
      numLocalByteSlices: 0,
      numGlobalInts: 3, // hash, amount, created, claimed
      numGlobalByteSlices: 2, // sender
      appArgs: appArgs
    });

    console.log('✅ Created single app creation transaction');
    
    return {
      transaction: appCreateTxn,
      txId: appCreateTxn.txID()
    };
  } catch (error) {
    console.error('❌ Error creating transaction:', error);
    throw new Error(`Failed to create transaction: ${error.message}`);
  }
}

async function deployContract(compiledProgram, senderAddress, claimHash, amount, network = 'testnet') {
  try {
    console.log('🔍 deployContract called with:', {
      compiledProgramLength: compiledProgram?.length,
      senderAddress: senderAddress,
      senderAddressType: typeof senderAddress,
      claimHashLength: claimHash?.length,
      amount: amount,
      network: network
    });
    
    // Validate inputs
    if (!compiledProgram || !(compiledProgram instanceof Uint8Array)) {
      throw new Error('Invalid compiled program - must be Uint8Array');
    }
    
    if (!claimHash || !(claimHash instanceof Uint8Array)) {
      throw new Error('Invalid claim hash - must be Uint8Array');
    }
    
    if (!amount || amount <= 0) {
      throw new Error('Invalid amount - must be positive number');
    }

    // Validate and clean the sender address
    const validatedSenderAddress = validateAlgorandAddress(senderAddress);

    const algodClient = createAlgodClient(network);
    
    // Test connection and get suggested params
    let suggestedParams;
    try {
      suggestedParams = await algodClient.getTransactionParams().do();
      console.log('✅ Successfully fetched transaction parameters');
      
      // Fix genesisHash if it's not a Uint8Array (bug in some algosdk versions)
      if (suggestedParams.genesisHash && !(suggestedParams.genesisHash instanceof Uint8Array)) {
        const hashArray = Object.values(suggestedParams.genesisHash);
        suggestedParams.genesisHash = new Uint8Array(hashArray);
        console.log('📝 Fixed genesisHash format');
      }
      
      // Ensure proper fee is set
      // For app creation, use standard fee
      if (!suggestedParams.fee || suggestedParams.fee === 0n) {
        // Application creation requires standard fee
        suggestedParams.fee = 1000n; // 0.001 ALGO
        suggestedParams.flatFee = true; // Use flat fee
        console.log('📝 Set transaction fee: 1000 microAlgos for app creation');
      }
    } catch (paramError) {
      console.error('❌ Failed to fetch transaction parameters:', paramError);
      throw new Error(`Network connection failed: ${paramError.message}`);
    }
    
    // Validate suggested params - using correct field names from algosdk
    if (!suggestedParams || suggestedParams.fee === undefined || !suggestedParams.firstValid || !suggestedParams.lastValid) {
      console.error('Invalid params structure:', {
        hasSuggestedParams: !!suggestedParams,
        hasFee: suggestedParams?.fee !== undefined,
        hasFirstValid: !!suggestedParams?.firstValid,
        hasLastValid: !!suggestedParams?.lastValid
      });
      throw new Error('Invalid transaction parameters received from network');
    }

    // Create clear program (simple program that always approves)
    const clearProgram = new Uint8Array([0x06, 0x81, 0x01]); // TEAL: #pragma version 6; int 1; return
    
    // Prepare application arguments as Uint8Array
    const appArgs = [
      new TextEncoder().encode('setup'),
      claimHash,
      algosdk.encodeUint64(Math.floor(amount * 1000000)) // Convert ALGO to microAlgos
    ];
    
    // Validate all appArgs are Uint8Array
    appArgs.forEach((arg, index) => {
      if (!(arg instanceof Uint8Array)) {
        throw new Error(`Application argument ${index} is not Uint8Array`);
      }
    });

    console.log('📝 Creating application transaction with:');
    console.log(`  - From: ${validatedSenderAddress}`);
    console.log(`  - Approval program size: ${compiledProgram.length} bytes`);
    console.log(`  - Clear program size: ${clearProgram.length} bytes`);
    console.log(`  - App args count: ${appArgs.length}`);
    console.log(`  - Amount (microAlgos): ${Math.floor(amount * 1000000)}`);
    console.log(`  ⚠️  Note: Account needs min balance for app creation (0.1 ALGO + 0.1 ALGO per global state var)`);
    
    // Log the suggestedParams to debug
    console.log('📝 Suggested params structure:', {
      flatFee: suggestedParams.flatFee,
      fee: suggestedParams.fee?.toString(),
      firstValid: suggestedParams.firstValid?.toString(),
      lastValid: suggestedParams.lastValid?.toString(),
      genesisID: suggestedParams.genesisID,
      minFee: suggestedParams.minFee?.toString()
    });

    // Log the exact parameters being passed
    console.log('📝 Transaction parameters:', {
      from: validatedSenderAddress,
      fromType: typeof validatedSenderAddress,
      fromValue: validatedSenderAddress,
      hasApprovalProgram: !!compiledProgram,
      hasClearProgram: !!clearProgram,
      appArgsLength: appArgs.length
    });

    // Create application creation transaction with all required parameters
    const appCreateTxn = algosdk.makeApplicationCreateTxnFromObject({
      sender: validatedSenderAddress,  // Changed from 'from' to 'sender'
      suggestedParams: suggestedParams,
      onComplete: algosdk.OnApplicationComplete.NoOpOC,
      approvalProgram: compiledProgram,
      clearProgram: clearProgram,
      numLocalInts: 0,
      numLocalByteSlices: 0,
      numGlobalInts: 2, // amount, claimed
      numGlobalByteSlices: 1, // claim_hash
      appArgs: appArgs
      // Remove undefined fields as they might cause issues
    });

    console.log('✅ Application transaction created successfully');
    
    // For now, return just the app creation transaction
    // We'll handle funding after the app is created and we know the real app ID
    
    // Get transaction ID
    let txId;
    try {
      txId = appCreateTxn.txID();
      console.log(`  - Transaction ID: ${txId}`);
    } catch (txIdError) {
      console.error('❌ Error getting transaction ID:', txIdError);
      throw new Error('Failed to get transaction ID from created transaction');
    }

    return {
      transaction: appCreateTxn,
      txId: txId
    };
  } catch (error) {
    console.error('❌ Error creating contract deployment transaction:', error);
    
    // Provide more specific error information
    if (error.message.includes('Address must not be null')) {
      throw new Error('Invalid sender address provided to transaction creation');
    } else if (error.message.includes('suggestedParams')) {
      throw new Error('Failed to get valid network parameters - check network connectivity');
    } else if (error.message.includes('approvalProgram')) {
      throw new Error('Invalid approval program - compilation may have failed');
    } else {
      throw new Error(`Failed to create contract deployment transaction: ${error.message}`);
    }
  }
}


// Helper function to safely extract and convert application ID to number
function extractApplicationId(confirmedTxn) {
  // Try multiple possible locations for the app ID
  let rawAppId = confirmedTxn['application-index'] || 
                 confirmedTxn['applicationIndex'] || 
                 confirmedTxn.applicationIndex ||
                 confirmedTxn['app-id'] ||
                 confirmedTxn.appId;
  
  // Check if it's nested in txn or other objects
  if (!rawAppId && confirmedTxn.txn) {
    rawAppId = confirmedTxn.txn['application-index'] || 
               confirmedTxn.txn.applicationIndex ||
               confirmedTxn.txn['app-id'] ||
               confirmedTxn.txn.appId;
  }
  
  console.log('📝 Raw application index:', rawAppId, 'type:', typeof rawAppId);
  
  // Ensure appId is a proper number - handle all possible types
  let appId = null;
  
  if (rawAppId !== null && rawAppId !== undefined) {
    if (typeof rawAppId === 'string') {
      const parsed = parseInt(rawAppId, 10);
      if (!isNaN(parsed) && parsed > 0) {
        appId = parsed;
      }
    } else if (typeof rawAppId === 'bigint') {
      const converted = Number(rawAppId);
      if (Number.isSafeInteger(converted) && converted > 0) {
        appId = converted;
      }
    } else if (typeof rawAppId === 'number') {
      if (Number.isInteger(rawAppId) && rawAppId > 0) {
        appId = rawAppId;
      }
    } else if (typeof rawAppId === 'object' && rawAppId !== null) {
      // Handle case where rawAppId might be an object with numeric properties
      // This prevents objects from being passed through
      console.log('⚠️ Application ID is an object, attempting to extract numeric value:', rawAppId);
      
      // Try to find a numeric property that could be the app ID
      const possibleKeys = ['value', 'id', 'appId', 'applicationId', 'index'];
      for (const key of possibleKeys) {
        if (rawAppId[key] !== undefined) {
          const candidate = rawAppId[key];
          if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) {
            appId = candidate;
            console.log(`✅ Extracted app ID from object.${key}: ${appId}`);
            break;
          } else if (typeof candidate === 'string') {
            const parsed = parseInt(candidate, 10);
            if (!isNaN(parsed) && parsed > 0) {
              appId = parsed;
              console.log(`✅ Extracted and parsed app ID from object.${key}: ${appId}`);
              break;
            }
          }
        }
      }
      
      // If we still don't have a valid appId, this is an error
      if (appId === null) {
        console.error('❌ Could not extract valid app ID from object:', rawAppId);
      }
    }
  }
  
  console.log('📝 Parsed application ID:', appId, 'type:', typeof appId);
  
  return appId;
}

// Root endpoint to confirm server is running
app.get('/', (req, res) => {
  res.json({ 
    message: 'RandCash API Server is running!',
    version: '1.0.0',
    endpoints: [
      'GET /api/health',
      'POST /api/create-claim',
      'POST /api/submit-transaction',
      'POST /api/claim-funds'
    ],
    timestamp: new Date().toISOString()
  });
});

// API endpoint to create claim
app.post('/api/create-claim', async (req, res) => {
  try {
    const { amount, recipient, message, senderAddress, network = 'testnet' } = req.body;

    console.log(`📥 Received create-claim request:`, {
      amount,
      recipient: recipient ? `${recipient.substring(0, 5)}...` : 'undefined',
      senderAddress: senderAddress ? `${senderAddress.substring(0, 8)}...` : 'undefined',
      senderAddressType: typeof senderAddress,
      senderAddressValue: senderAddress,
      network,
      hasMessage: !!message
    });

    // Validate network
    if (!NETWORK_CONFIGS[network]) {
      return res.status(400).json({ error: 'Invalid network specified' });
    }

    // Validate input
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    
    // Email is now optional - only validate format if provided
    if (recipient && recipient.trim()) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(recipient.trim())) {
        return res.status(400).json({ error: 'Please provide a valid email address' });
      }
    }
    
    // Validate sender address using our helper function
    let validatedSenderAddress;
    try {
      validatedSenderAddress = validateAlgorandAddress(senderAddress);
    } catch (addressError) {
      return res.status(400).json({ error: `Invalid sender address: ${addressError.message}` });
    }


    console.log(`✅ Creating claim for ${amount} ALGO from ${validatedSenderAddress} to ${recipient} on ${NETWORK_CONFIGS[network].name}`);

    // Generate claim code and hash it
    const claimCode = generateClaimCode();
    const hashedClaimCode = hashClaimCode(claimCode);
    
    // Create TEAL program
    console.log('📝 Creating TEAL program...');
    const tealProgram = createHashClaimContractTeal(hashedClaimCode, validatedSenderAddress, amount);
    
    // Compile the TEAL program
    console.log('🔨 Compiling TEAL program...');
    const { compiledProgram, hash: programHash } = await compileTealProgram(tealProgram, network);
    console.log(`✅ TEAL compilation successful, hash: ${programHash}`);
    
    // Create single app creation transaction
    console.log('📋 Creating single app creation transaction...');
    const { transaction, txId } = await createSingleAppTransaction(
      compiledProgram, 
      validatedSenderAddress, 
      hashedClaimCode, 
      amount,
      network
    );
    console.log('✅ Created single transaction');

    // No need to store claim information - everything is on-chain now

    console.log(`🎉 Single transaction created successfully on ${NETWORK_CONFIGS[network].name}:`);
    console.log(`- Claim code: ${claimCode}`);
    console.log(`- Transaction ID: ${txId}`);
    console.log(`- Program hash: ${programHash}`);
    console.log(`- Email will be sent after contract deployment`);

    // Return single transaction
    res.json({
      claimCode,
      transactionId: txId,
      programHash,
      deploymentTransaction: Buffer.from(algosdk.encodeUnsignedTransaction(transaction)).toString('base64'),
      claimDetails: {
        recipient,
        amount,
        message,
        network,
        claimCode
      }
    });

  } catch (error) {
    console.error('❌ Error creating claim:', error);
    res.status(500).json({ 
      error: error.message || 'Internal server error occurred while creating claim' 
    });
  }
});

// API endpoint to submit signed transaction (atomic group)
app.post('/api/submit-transaction', async (req, res) => {
  try {
    const { signedTransaction, signedTransactions, network = 'testnet', claimDetails } = req.body;
    
    console.log(`📥 Received submit-transaction request for ${NETWORK_CONFIGS[network]?.name || network}`);
    
    // Validate network
    if (!NETWORK_CONFIGS[network]) {
      return res.status(400).json({ error: 'Invalid network specified' });
    }
    
    // Only handle single transactions
    if (!signedTransaction) {
      return res.status(400).json({ error: 'Signed transaction is required' });
    }

    const algodClient = createAlgodClient(network);

    let txResponse;
    let primaryTxId;

    try {
      // Handle single transaction
      console.log('📤 Submitting single signed transaction to network...');
      const signedTxnBuffer = Buffer.from(signedTransaction, 'base64');
      console.log(`📝 Transaction buffer length: ${signedTxnBuffer.length} bytes`);
      
      txResponse = await algodClient.sendRawTransaction(signedTxnBuffer).do();
      primaryTxId = txResponse?.txid || txResponse?.txId || txResponse?.transactionID;
      
      console.log('✅ Transaction submitted successfully');
      console.log(`   - Transaction ID: ${primaryTxId}`);
    } catch (submitError) {
      console.error('❌ Failed to submit transaction:', submitError);
      throw new Error(`Transaction submission failed: ${submitError.message}`);
    }
    
    // Validate transaction ID
    if (!primaryTxId) {
      console.error('❌ No transaction ID found in response');
      throw new Error('No transaction ID returned from submission');
    }
    
    // Wait for confirmation
    console.log('⏳ Waiting for transaction confirmation...');
    const confirmedTxn = await algosdk.waitForConfirmation(algodClient, primaryTxId, 15);
    console.log(`✅ Transaction confirmed in round ${confirmedTxn['confirmed-round']}`);

    // Extract application ID from confirmed transaction
    let appId = null;
    let contractAddress = null;
    
    appId = extractApplicationId(confirmedTxn);
    if (appId && appId > 0) {
      contractAddress = algosdk.getApplicationAddress(appId).toString();
      console.log(`✅ App created with ID: ${appId}, Address: ${contractAddress}`);
    }

    // Update claim storage with actual application ID and contract address
    if (claimDetails && claimDetails.claimCode && appId) {
      const claimInfo = getClaim(claimDetails.claimCode);
      if (claimInfo) {
        claimInfo.applicationId = appId;
        claimInfo.contractAddress = contractAddress;
        storeClaim(claimDetails.claimCode, claimInfo);
        console.log(`✅ Updated claim storage with actual app ID ${appId}`);
      }
    }

    // Send email notification if claim details are provided
    let notificationResult = { success: false, method: 'not_attempted' };
    if (claimDetails) {
      console.log('📧 Sending email notification after successful deployment...');
      try {
        notificationResult = await sendEmailNotification(
          claimDetails.recipient,
          claimDetails.claimCode,
          claimDetails.amount,
          claimDetails.message,
          network,
          appId
        );
        console.log(`✅ Email notification: ${notificationResult.success ? 'sent' : 'failed'}`);
      } catch (emailError) {
        console.error('❌ Failed to send email notification:', emailError);
        // Don't fail the whole request if email fails - atomic group is already confirmed
      }
    }

    res.json({
      success: true,
      transactionId: primaryTxId,
      applicationId: appId,
      contractAddress: contractAddress,
      confirmedRound: confirmedTxn['confirmed-round'],
      notificationSent: notificationResult.success,
      notificationMethod: notificationResult.method
    });

  } catch (error) {
    console.error('❌ Error submitting transaction:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to submit transaction' 
    });
  }
});

// API endpoint to claim funds
app.post('/api/claim-funds', async (req, res) => {
  try {
    const { claimCode, walletAddress, network = 'testnet' } = req.body;
    
    console.log(`📥 Received claim-funds request:`, {
      claimCode: claimCode ? `${claimCode.substring(0, 8)}...` : 'undefined',
      walletAddress: walletAddress ? `${walletAddress.substring(0, 8)}...` : 'undefined',
      network
    });

    // Validate network
    if (!NETWORK_CONFIGS[network]) {
      return res.status(400).json({ error: 'Invalid network specified' });
    }

    // Validate input
    if (!claimCode || !claimCode.trim()) {
      return res.status(400).json({ error: 'Claim code is required' });
    }
    
    if (!walletAddress || !walletAddress.trim()) {
      return res.status(400).json({ error: 'Wallet address is required' });
    }

    // Validate wallet address
    let validatedWalletAddress;
    try {
      validatedWalletAddress = validateAlgorandAddress(walletAddress);
    } catch (addressError) {
      return res.status(400).json({ error: `Invalid wallet address: ${addressError.message}` });
    }

    // Get claim information
    const claimInfo = getClaim(claimCode.trim().toUpperCase());
    if (!claimInfo) {
      return res.status(404).json({ error: 'Invalid claim code. Please check your code and try again.' });
    }

    // Check if already claimed
    if (claimInfo.claimed) {
      return res.status(400).json({ error: 'This claim code has already been used.' });
    }

    // Check if network matches
    if (claimInfo.network !== network) {
      return res.status(400).json({ 
        error: `This claim code is for ${NETWORK_CONFIGS[claimInfo.network].name}, but you're on ${NETWORK_CONFIGS[network].name}. Please switch networks.` 
      });
    }

    console.log(`✅ Valid claim found: ${claimInfo.amount} ALGO for ${claimInfo.recipient}`);
    console.log(`📝 Claim info details:`, {
      applicationId: claimInfo.applicationId,
      contractAddress: claimInfo.contractAddress,
      amount: claimInfo.amount,
      network: claimInfo.network,
      hasClaimHash: !!claimInfo.hashedClaimCode,
      hasFundingTxId: !!claimInfo.fundingTxId,
      txId: claimInfo.txId?.substring(0, 10) + '...',
      fundingTxId: claimInfo.fundingTxId?.substring(0, 10) + '...' || 'None',
      createdAt: claimInfo.createdAt
    });

    // Check if we have the application ID
    if (!claimInfo.applicationId) {
      return res.status(400).json({ 
        error: 'Contract not yet deployed. Please wait for the sender to complete the transaction first.' 
      });
    }

    // Create Algorand client for the network
    const algodClient = createAlgodClient(network);

    // Check if user needs seeding before proceeding with claim
    console.log('🔍 Checking if user needs seed funding...');
    try {
      const needsSeeding = await seedWalletService.needsSeeding(validatedWalletAddress, network, 0.001);
      
      if (needsSeeding) {
        console.log(`💰 User needs seed funding. Attempting to fund ${validatedWalletAddress}...`);
        
        const seedResult = await seedWalletService.fundAccount(
          validatedWalletAddress, 
          0.004, // 0.004 ALGO for transaction fees
          network, 
          claimCode.trim().toUpperCase()
        );
        
        if (seedResult.success) {
          console.log(`✅ Seed funding successful:`);
          console.log(`   - Amount: ${seedResult.amount} ALGO`);
          console.log(`   - TX ID: ${seedResult.transactionId}`);
          console.log(`   - Remaining seed balance: ${seedResult.seedWalletBalance} ALGO`);
        } else {
          console.log(`⚠️ Seed funding failed: ${seedResult.message}`);
          
          // For rate limiting, return specific error
          if (seedResult.reason === 'rate_limited') {
            return res.status(429).json({ 
              error: seedResult.message 
            });
          }
          
          // For other failures, warn but continue with claim attempt
          console.log('⚠️ Continuing with claim attempt despite seeding failure');
        }
      } else {
        console.log('✅ User has sufficient balance, no seeding needed');
      }
    } catch (seedError) {
      console.error('❌ Error during seeding check/attempt:', seedError);
      // Continue with claim attempt even if seeding fails
      console.log('⚠️ Continuing with claim attempt despite seeding error');
    }

    // Check claimer's balance - warn but don't block if low
    try {
      const claimerInfo = await algodClient.accountInformation(validatedWalletAddress).do();
      const claimerBalance = typeof claimerInfo.amount === 'bigint' ? claimerInfo.amount : BigInt(claimerInfo.amount);
      console.log(`💰 Claimer balance: ${Number(claimerBalance) / 1000000} ALGO (${claimerBalance.toString()} microAlgos)`);
      
      if (claimerBalance < 1000n) { // Need at least 0.001 ALGO for transaction fee
        console.log('⚠️ Claimer still has low balance after seeding attempt');
      }
    } catch (balanceError) {
      console.error('❌ Error checking claimer balance:', balanceError);
    }

    // Check contract balance before proceeding
    try {
      const appAddress = algosdk.getApplicationAddress(claimInfo.applicationId);
      console.log(`🔍 Checking balance for App ID ${claimInfo.applicationId} at address ${appAddress}`);
      
      const accountInfo = await algodClient.accountInformation(appAddress).do();
      const contractBalance = typeof accountInfo.amount === 'bigint' ? accountInfo.amount : BigInt(accountInfo.amount);
      console.log(`📊 Contract balance: ${Number(contractBalance) / 1000000} ALGO (${contractBalance.toString()} microAlgos)`);
      
      if (contractBalance === 0n) {
        console.log(`❌ Contract at ${appAddress} has 0 balance!`);
        console.log(`   App ID: ${claimInfo.applicationId}`);
        console.log(`   Expected amount: ${claimInfo.amount} ALGO`);
        console.log(`   Has funding TX ID: ${!!claimInfo.fundingTxId}`);
        console.log(`   Claim created: ${claimInfo.createdAt}`);
        
        // Provide different error messages based on whether this was atomic or not
        const errorMessage = claimInfo.fundingTxId 
          ? `Contract was not funded properly during creation. This may be an old claim code created before atomic transactions were enabled. Please ask the sender to create a new claim.`
          : `Contract has not been funded yet. This claim was created but the funding step failed. Please ask the sender to try sending again.`;
          
        return res.status(400).json({
          error: errorMessage,
          contractAddress: appAddress.toString(),
          applicationId: claimInfo.applicationId
        });
      }
      
      // Check if contract has enough to pay the claim amount + fee
      const claimAmountMicroAlgos = BigInt(Math.floor(claimInfo.amount * 1000000));
      const requiredAmount = claimAmountMicroAlgos + 1000n; // Amount + fee for inner tx
      if (contractBalance < requiredAmount) {
        return res.status(400).json({
          error: `Contract has insufficient funds. Has ${Number(contractBalance) / 1000000} ALGO but needs ${Number(requiredAmount) / 1000000} ALGO (${claimInfo.amount} + 0.001 for fees).`
        });
      }
    } catch (balanceError) {
      console.error('❌ Error checking contract balance:', balanceError);
      return res.status(500).json({
        error: 'Unable to verify contract balance. Please try again later.'
      });
    }

    // Get suggested parameters
    let suggestedParams;
    try {
      suggestedParams = await algodClient.getTransactionParams().do();
    } catch (paramError) {
      console.error('❌ Failed to fetch transaction parameters:', paramError);
      throw new Error(`Network connection failed: ${paramError.message}`);
    }

    // Create application call transaction to claim funds
    console.log('📝 Creating claim transaction...');
    const claimHash = hashClaimCode(claimCode.trim().toUpperCase());
    
    const appArgs = [
      new TextEncoder().encode('claim'),
      claimHash
    ];

    // Use minimum fee - we'll implement fee sponsorship in future
    // For now, the claimer needs minimal ALGO for fees

    const appCallTxn = algosdk.makeApplicationCallTxnFromObject({
      sender: validatedWalletAddress,
      suggestedParams: suggestedParams,
      appIndex: claimInfo.applicationId,
      onComplete: algosdk.OnApplicationComplete.NoOpOC,
      appArgs: appArgs
    });

    // Encode the transaction for signing
    const txnToSign = Buffer.from(algosdk.encodeUnsignedTransaction(appCallTxn)).toString('base64');

    console.log(`✅ Claim transaction created for app ${claimInfo.applicationId}`);
    console.log(`- Claimer: ${validatedWalletAddress}`);
    console.log(`- Amount: ${claimInfo.amount} ALGO`);

    // For now, return the transaction to be signed by the frontend
    // The frontend will sign and submit it back
    res.json({
      success: false, // Not yet complete - needs signing
      requiresSigning: true,
      transactionToSign: txnToSign,
      amount: claimInfo.amount,
      message: claimInfo.message,
      claimCode: claimCode.trim().toUpperCase()
    });

  } catch (error) {
    console.error('❌ Error claiming funds:', error);
    res.status(500).json({ 
      error: error.message || 'Internal server error occurred while claiming funds' 
    });
  }
});

// API endpoint to submit signed claim transaction
app.post('/api/submit-claim', async (req, res) => {
  try {
    const { signedTransaction, claimCode, network = 'testnet' } = req.body;
    
    console.log(`📥 Received submit-claim request for claim code ${claimCode?.substring(0, 8)}...`);
    
    // Validate network
    if (!NETWORK_CONFIGS[network]) {
      return res.status(400).json({ error: 'Invalid network specified' });
    }
    
    if (!signedTransaction) {
      return res.status(400).json({ error: 'Signed transaction is required' });
    }

    if (!claimCode) {
      return res.status(400).json({ error: 'Claim code is required' });
    }

    // Get claim information
    const claimInfo = getClaim(claimCode.trim().toUpperCase());
    if (!claimInfo) {
      return res.status(404).json({ error: 'Invalid claim code' });
    }

    // Check if already claimed
    if (claimInfo.claimed) {
      return res.status(400).json({ error: 'This claim code has already been used.' });
    }

    // Create Algorand client
    const algodClient = createAlgodClient(network);

    // Decode and submit the signed transaction
    console.log('📤 Submitting claim transaction to Algorand network...');
    const signedTxnBytes = new Uint8Array(Buffer.from(signedTransaction, 'base64'));
    const txResponse = await algodClient.sendRawTransaction(signedTxnBytes).do();
    
    // Extract transaction ID - handle different response formats
    const txId = txResponse?.txid || txResponse?.txId || txResponse?.transactionID;
    
    if (!txId) {
      console.error('❌ No transaction ID in response:', txResponse);
      throw new Error('No valid transaction ID was specified by the network');
    }
    
    console.log(`✅ Claim transaction submitted successfully: ${txId}`);
    
    // Wait for confirmation
    console.log('⏳ Waiting for transaction confirmation...');
    const confirmedTxn = await algosdk.waitForConfirmation(algodClient, txId, 15);
    
    console.log(`✅ Claim transaction confirmed in round ${confirmedTxn['confirmed-round']}`);

    // Mark claim as used
    markClaimAsUsed(claimCode.trim().toUpperCase());

    console.log(`🎉 Claim processed successfully:`);
    console.log(`- Amount: ${claimInfo.amount} ALGO`);
    console.log(`- Transaction ID: ${txId}`);

    res.json({
      success: true,
      transactionId: txId,
      amount: claimInfo.amount,
      confirmedRound: confirmedTxn['confirmed-round'],
      message: claimInfo.message
    });

  } catch (error) {
    console.error('❌ Error submitting claim transaction:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to submit claim transaction' 
    });
  }
});

// API endpoint to submit a simple signed transaction (for funding)
app.post('/api/submit-funding-transaction', async (req, res) => {
  try {
    const { signedTransaction, network = 'testnet', claimCode } = req.body;
    
    console.log(`📥 Received funding transaction submission`);
    
    // Validate network
    if (!NETWORK_CONFIGS[network]) {
      return res.status(400).json({ error: 'Invalid network specified' });
    }
    
    if (!signedTransaction) {
      return res.status(400).json({ error: 'Signed transaction is required' });
    }

    // Create Algorand client
    const algodClient = createAlgodClient(network);

    // Decode and submit the signed transaction
    console.log('📤 Submitting funding transaction to Algorand network...');
    const signedTxnBytes = new Uint8Array(Buffer.from(signedTransaction, 'base64'));
    const txResponse = await algodClient.sendRawTransaction(signedTxnBytes).do();
    
    // Extract transaction ID
    const txId = txResponse?.txid || txResponse?.txId || txResponse?.transactionID;
    
    if (!txId) {
      console.error('❌ No transaction ID in response:', txResponse);
      throw new Error('No valid transaction ID was specified by the network');
    }
    
    console.log(`✅ Funding transaction submitted successfully: ${txId}`);
    
    // Wait for confirmation
    console.log('⏳ Waiting for transaction confirmation...');
    const confirmedTxn = await algosdk.waitForConfirmation(algodClient, txId, 15);
    
    console.log(`✅ Funding transaction confirmed in round ${confirmedTxn['confirmed-round']}`);

    // Update claim storage with funding transaction ID if claim code provided
    if (claimCode) {
      const claimInfo = getClaim(claimCode);
      if (claimInfo) {
        claimInfo.fundingTxId = txId;
        storeClaim(claimCode, claimInfo);
        console.log(`✅ Updated claim storage with funding TX ID ${txId}`);
      } else {
        console.log(`⚠️ Could not find claim for code ${claimCode} to update funding TX ID`);
      }
    }

    res.json({
      success: true,
      transactionId: txId,
      confirmedRound: confirmedTxn['confirmed-round']
    });

  } catch (error) {
    console.error('❌ Error submitting funding transaction:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to submit funding transaction' 
    });
  }
});

// API endpoint to fund contract after creation
app.post('/api/fund-contract', async (req, res) => {
  try {
    const { applicationId, amount, senderAddress, network = 'testnet' } = req.body;
    
    console.log(`📥 Received fund-contract request for app ${applicationId}`);
    
    // Validate network
    if (!NETWORK_CONFIGS[network]) {
      return res.status(400).json({ error: 'Invalid network specified' });
    }
    
    // Validate inputs
    if (!applicationId || applicationId <= 0) {
      return res.status(400).json({ error: 'Valid application ID is required' });
    }
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Amount must be greater than 0' });
    }
    
    // Validate sender address
    let validatedSenderAddress;
    try {
      validatedSenderAddress = validateAlgorandAddress(senderAddress);
    } catch (addressError) {
      return res.status(400).json({ error: `Invalid sender address: ${addressError.message}` });
    }
    
    // Create Algorand client
    const algodClient = createAlgodClient(network);
    
    // Get suggested parameters
    const suggestedParams = await algodClient.getTransactionParams().do();
    
    // Get the application address
    const appAddress = algosdk.getApplicationAddress(applicationId);
    console.log(`📝 Contract address: ${appAddress}`);
    
    // Create payment transaction to fund the contract
    const fundingTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: validatedSenderAddress,
      receiver: appAddress,
      amount: Math.floor(amount * 1000000), // Convert ALGO to microAlgos
      suggestedParams: suggestedParams,
      note: new TextEncoder().encode('RandCash contract funding')
    });
    
    // Encode transaction for signing
    const txnToSign = Buffer.from(algosdk.encodeUnsignedTransaction(fundingTxn)).toString('base64');
    const txId = fundingTxn.txID();
    
    console.log(`✅ Funding transaction created:`);
    console.log(`- Amount: ${amount} ALGO`);
    console.log(`- To contract: ${appAddress}`);
    console.log(`- Transaction ID: ${txId}`);
    
    res.json({
      transactionToSign: txnToSign,
      transactionId: txId,
      contractAddress: appAddress.toString()
    });
    
  } catch (error) {
    console.error('❌ Error creating funding transaction:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to create funding transaction' 
    });
  }
});

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    const network = req.query.network || 'testnet';
    
    // Validate network
    if (!NETWORK_CONFIGS[network]) {
      return res.status(400).json({ error: 'Invalid network specified' });
    }

    // Test Algorand connection
    const algodClient = createAlgodClient(network);
    const status = await algodClient.status().do();
    
    // Check seed wallet status
    const seedWalletStatus = await seedWalletService.checkSeedWalletBalance(network);
    
    res.json({ 
      status: 'OK', 
      timestamp: new Date().toISOString(),
      algorand: {
        network: NETWORK_CONFIGS[network].name,
        node: NETWORK_CONFIGS[network].algodServer,
        lastRound: status['last-round']
      },
      services: {
        email: isValidPicaConfig ? 'connected' : 'simulated',
        seedWallet: seedWalletStatus.configured ? {
          status: 'configured',
          address: seedWalletStatus.address,
          balance: `${seedWalletStatus.balance} ALGO`
        } : {
          status: 'not_configured'
        }
      }
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'ERROR', 
      timestamp: new Date().toISOString(),
      error: error.message 
    });
  }
});

// API endpoint to get seed wallet address for contributions
app.get('/api/seed-wallet-address', async (req, res) => {
  try {
    const network = req.query.network || 'testnet';
    
    // Validate network
    if (!NETWORK_CONFIGS[network]) {
      return res.status(400).json({ error: 'Invalid network specified' });
    }
    
    // Check seed wallet status
    const seedWalletStatus = await seedWalletService.checkSeedWalletBalance(network);
    
    if (!seedWalletStatus.configured) {
      return res.status(503).json({ 
        error: 'Seed wallet service not configured',
        configured: false
      });
    }
    
    res.json({
      configured: true,
      address: seedWalletStatus.address,
      balance: seedWalletStatus.balance,
      recommendedContribution: 0.005 // ALGO
    });
  } catch (error) {
    console.error('❌ Error getting seed wallet address:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to get seed wallet address'
    });
  }
});

// Debug endpoint to check claim status (only for development)
app.get('/api/debug/claims', (req, res) => {
  try {
    const claims = Array.from(claimStorage.entries()).map(([code, data]) => ({
      code: code.substring(0, 8) + '...',
      amount: data.amount,
      recipient: data.recipient,
      applicationId: data.applicationId,
      contractAddress: data.contractAddress,
      claimed: data.claimed,
      fundingTxId: data.fundingTxId ? data.fundingTxId.substring(0, 10) + '...' : null,
      createdAt: data.createdAt,
      network: data.network
    }));
    
    res.json({
      totalClaims: claims.length,
      claims: claims
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint to clear incomplete claims (only for development)
app.post('/api/debug/clear-incomplete-claims', (req, res) => {
  try {
    let removed = 0;
    const toRemove = [];
    
    for (const [code, data] of claimStorage.entries()) {
      // Remove claims that don't have applicationId (incomplete deployment)
      if (!data.applicationId) {
        toRemove.push(code);
        removed++;
      }
    }
    
    toRemove.forEach(code => claimStorage.delete(code));
    
    res.json({
      message: `Removed ${removed} incomplete claims`,
      removedCount: removed,
      remainingClaims: claimStorage.size
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint to check seed wallet status
app.get('/api/debug/seed-wallet', async (req, res) => {
  try {
    const network = req.query.network || 'testnet';
    const seedWalletStatus = await seedWalletService.checkSeedWalletBalance(network);
    
    res.json({
      seedWallet: seedWalletStatus,
      isConfigured: seedWalletStatus.configured
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// New contract-based claim endpoint
app.post('/api/claim-with-code', async (req, res) => {
  try {
    const { applicationId, claimCode, walletAddress, network = 'testnet' } = req.body;
    
    console.log(`📥 Received claim-with-code request for app ${applicationId}`);
    
    // Validate network
    if (!NETWORK_CONFIGS[network]) {
      return res.status(400).json({ error: 'Invalid network specified' });
    }
    
    // Validate inputs
    if (!applicationId || applicationId <= 0) {
      return res.status(400).json({ error: 'Valid application ID is required' });
    }
    
    if (!claimCode || !claimCode.trim()) {
      return res.status(400).json({ error: 'Claim code is required' });
    }
    
    // Validate wallet address
    let validatedWalletAddress;
    try {
      validatedWalletAddress = validateAlgorandAddress(walletAddress);
    } catch (addressError) {
      return res.status(400).json({ error: `Invalid wallet address: ${addressError.message}` });
    }
    
    // Create Algorand client
    const algodClient = createAlgodClient(network);
    
    // Get suggested parameters
    const suggestedParams = await algodClient.getTransactionParams().do();
    
    // Create application call transaction to claim funds
    const claimTxn = algosdk.makeApplicationCallTxnFromObject({
      sender: validatedWalletAddress,
      suggestedParams: suggestedParams,
      appIndex: applicationId,
      onComplete: algosdk.OnApplicationComplete.NoOpOC,
      appArgs: [
        new TextEncoder().encode('claim'),
        new TextEncoder().encode(claimCode.trim())
      ]
    });
    
    // Encode transaction for signing
    const txnToSign = Buffer.from(algosdk.encodeUnsignedTransaction(claimTxn)).toString('base64');
    const txId = claimTxn.txID();
    
    console.log(`✅ Claim transaction created: ${txId}`);
    
    res.json({
      transactionToSign: txnToSign,
      transactionId: txId,
      applicationId: applicationId
    });
    
  } catch (error) {
    console.error('❌ Error creating claim transaction:', error);
    res.status(500).json({ 
      error: error.message || 'Internal server error occurred while creating claim transaction' 
    });
  }
});

// New contract-based refund endpoint
app.post('/api/refund-funds', async (req, res) => {
  try {
    const { applicationId, walletAddress, network = 'testnet' } = req.body;
    
    console.log(`📥 Received refund-funds request for app ${applicationId}`);
    
    // Validate network
    if (!NETWORK_CONFIGS[network]) {
      return res.status(400).json({ error: 'Invalid network specified' });
    }
    
    // Validate inputs
    if (!applicationId || applicationId <= 0) {
      return res.status(400).json({ error: 'Valid application ID is required' });
    }
    
    // Validate wallet address
    let validatedWalletAddress;
    try {
      validatedWalletAddress = validateAlgorandAddress(walletAddress);
    } catch (addressError) {
      return res.status(400).json({ error: `Invalid wallet address: ${addressError.message}` });
    }
    
    // Create Algorand client
    const algodClient = createAlgodClient(network);
    
    // Get suggested parameters
    const suggestedParams = await algodClient.getTransactionParams().do();
    
    // Create application call transaction to refund funds
    const refundTxn = algosdk.makeApplicationCallTxnFromObject({
      sender: validatedWalletAddress,
      suggestedParams: suggestedParams,
      appIndex: applicationId,
      onComplete: algosdk.OnApplicationComplete.NoOpOC,
      appArgs: [
        new TextEncoder().encode('refund')
      ]
    });
    
    // Encode transaction for signing
    const txnToSign = Buffer.from(algosdk.encodeUnsignedTransaction(refundTxn)).toString('base64');
    const txId = refundTxn.txID();
    
    console.log(`✅ Refund transaction created: ${txId}`);
    
    res.json({
      transactionToSign: txnToSign,
      transactionId: txId,
      applicationId: applicationId
    });
    
  } catch (error) {
    console.error('❌ Error creating refund transaction:', error);
    res.status(500).json({ 
      error: error.message || 'Internal server error occurred while creating refund transaction' 
    });
  }
});

// API endpoint to get all contracts created by a wallet
app.get('/api/wallet-contracts/:walletAddress', async (req, res) => {
  try {
    const { walletAddress } = req.params;
    const network = req.query.network || 'testnet';
    
    console.log(`📥 Received wallet-contracts request for ${walletAddress.substring(0, 8)}... on ${network}`);
    
    // Validate network
    if (!NETWORK_CONFIGS[network]) {
      return res.status(400).json({ error: 'Invalid network specified' });
    }
    
    // Validate wallet address
    let validatedWalletAddress;
    try {
      validatedWalletAddress = validateAlgorandAddress(walletAddress);
    } catch (addressError) {
      return res.status(400).json({ error: `Invalid wallet address: ${addressError.message}` });
    }
    
    const algodClient = createAlgodClient(network);
    
    // Get account information to find created applications
    const accountInfo = await algodClient.accountInformation(validatedWalletAddress).do();
    const createdApps = accountInfo['created-apps'] || [];
    
    console.log(`📝 Found ${createdApps.length} applications created by wallet`);
    
    const contracts = [];
    
    // For each created application, get its current state
    for (const app of createdApps) {
      try {
        const appId = app.id;
        const appAddress = algosdk.getApplicationAddress(appId);
        
        // Get application global state
        const appInfo = await algodClient.getApplicationByID(appId).do();
        const globalState = appInfo.params['global-state'] || [];
        
        // Parse global state
        const parsedState = {};
        globalState.forEach(item => {
          const key = Buffer.from(item.key, 'base64').toString();
          let value;
          if (item.value.type === 1) { // bytes
            value = Buffer.from(item.value.bytes, 'base64');
          } else if (item.value.type === 2) { // uint
            value = item.value.uint;
          }
          parsedState[key] = value;
        });
        
        // Get contract account balance
        let contractBalance = 0;
        try {
          const contractAccountInfo = await algodClient.accountInformation(appAddress).do();
          contractBalance = Number(contractAccountInfo.amount) / 1000000; // Convert to ALGO
        } catch (balanceError) {
          console.log(`⚠️ Could not get balance for contract ${appId}: ${balanceError.message}`);
        }
        
        // Determine contract status
        const claimed = parsedState.claimed === 1;
        const amount = parsedState.amount ? Number(parsedState.amount) / 1000000 : 0;
        const created = parsedState.created || 0;
        const currentTime = Math.floor(Date.now() / 1000);
        const canRefund = !claimed && (currentTime - created) > 300; // 5 minutes
        const canDelete = contractBalance === 0;
        
        let status = 'Unknown';
        if (claimed) {
          status = 'Claimed';
        } else if (contractBalance > 0) {
          status = canRefund ? 'Refundable' : 'Active';
        } else {
          status = 'Empty';
        }
        
        contracts.push({
          applicationId: appId,
          contractAddress: appAddress.toString(),
          status: status,
          amount: amount,
          balance: contractBalance,
          claimed: claimed,
          canRefund: canRefund,
          canDelete: canDelete,
          createdTimestamp: created,
          createdDate: created ? new Date(created * 1000).toISOString() : null
        });
        
      } catch (appError) {
        console.error(`❌ Error processing app ${app.id}:`, appError.message);
        // Continue with other apps even if one fails
      }
    }
    
    console.log(`✅ Processed ${contracts.length} contracts for wallet`);
    
    res.json({
      walletAddress: validatedWalletAddress,
      network: network,
      contracts: contracts,
      totalContracts: contracts.length,
      activeContracts: contracts.filter(c => c.status === 'Active').length,
      claimedContracts: contracts.filter(c => c.status === 'Claimed').length,
      refundableContracts: contracts.filter(c => c.canRefund).length,
      deletableContracts: contracts.filter(c => c.canDelete).length
    });
    
  } catch (error) {
    console.error('❌ Error getting wallet contracts:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to get wallet contracts' 
    });
  }
});

// API endpoint to delete a contract
app.post('/api/delete-contract', async (req, res) => {
  try {
    const { applicationId, walletAddress, network = 'testnet' } = req.body;
    
    console.log(`📥 Received delete-contract request for app ${applicationId}`);
    
    // Validate network
    if (!NETWORK_CONFIGS[network]) {
      return res.status(400).json({ error: 'Invalid network specified' });
    }
    
    // Validate inputs
    if (!applicationId || applicationId <= 0) {
      return res.status(400).json({ error: 'Valid application ID is required' });
    }
    
    // Validate wallet address
    let validatedWalletAddress;
    try {
      validatedWalletAddress = validateAlgorandAddress(walletAddress);
    } catch (addressError) {
      return res.status(400).json({ error: `Invalid wallet address: ${addressError.message}` });
    }
    
    const algodClient = createAlgodClient(network);
    
    // Verify the caller is the creator of the application
    const appInfo = await algodClient.getApplicationByID(applicationId).do();
    const creator = appInfo.params.creator;
    
    if (creator !== validatedWalletAddress) {
      return res.status(403).json({ 
        error: 'Only the creator of the application can delete it' 
      });
    }
    
    // Check if contract has zero balance
    const appAddress = algosdk.getApplicationAddress(applicationId);
    const contractAccountInfo = await algodClient.accountInformation(appAddress).do();
    const contractBalance = Number(contractAccountInfo.amount);
    
    if (contractBalance > 0) {
      return res.status(400).json({
        error: `Cannot delete contract with non-zero balance. Current balance: ${contractBalance / 1000000} ALGO. Please refund or claim first.`
      });
    }
    
    // Get suggested parameters
    const suggestedParams = await algodClient.getTransactionParams().do();
    
    // Create application deletion transaction
    const deleteTxn = algosdk.makeApplicationDeleteTxnFromObject({
      sender: validatedWalletAddress,
      suggestedParams: suggestedParams,
      appIndex: applicationId
    });
    
    // Encode transaction for signing
    const txnToSign = Buffer.from(algosdk.encodeUnsignedTransaction(deleteTxn)).toString('base64');
    const txId = deleteTxn.txID();
    
    console.log(`✅ Delete transaction created for app ${applicationId}: ${txId}`);
    
    res.json({
      transactionToSign: txnToSign,
      transactionId: txId,
      applicationId: applicationId,
      message: 'Transaction created successfully. Sign and submit to delete the contract.'
    });
    
  } catch (error) {
    console.error('❌ Error creating delete transaction:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to create delete transaction' 
    });
  }
});

// API endpoint to submit signed delete transaction
app.post('/api/submit-delete', async (req, res) => {
  try {
    const { signedTransaction, applicationId, network = 'testnet' } = req.body;
    
    console.log(`📥 Received submit-delete request for app ${applicationId}`);
    
    // Validate network
    if (!NETWORK_CONFIGS[network]) {
      return res.status(400).json({ error: 'Invalid network specified' });
    }
    
    if (!signedTransaction) {
      return res.status(400).json({ error: 'Signed transaction is required' });
    }

    if (!applicationId) {
      return res.status(400).json({ error: 'Application ID is required' });
    }

    // Create Algorand client
    const algodClient = createAlgodClient(network);

    // Decode and submit the signed transaction
    console.log('📤 Submitting delete transaction to Algorand network...');
    const signedTxnBytes = new Uint8Array(Buffer.from(signedTransaction, 'base64'));
    const txResponse = await algodClient.sendRawTransaction(signedTxnBytes).do();
    
    // Extract transaction ID
    const txId = txResponse?.txid || txResponse?.txId || txResponse?.transactionID;
    
    if (!txId) {
      console.error('❌ No transaction ID in response:', txResponse);
      throw new Error('No valid transaction ID was specified by the network');
    }
    
    console.log(`✅ Delete transaction submitted successfully: ${txId}`);
    
    // Wait for confirmation
    console.log('⏳ Waiting for transaction confirmation...');
    const confirmedTxn = await algosdk.waitForConfirmation(algodClient, txId, 15);
    
    console.log(`✅ Delete transaction confirmed in round ${confirmedTxn['confirmed-round']}`);
    
    console.log(`🗑️ Contract ${applicationId} deleted successfully`);

    res.json({
      success: true,
      transactionId: txId,
      applicationId: applicationId,
      confirmedRound: confirmedTxn['confirmed-round'],
      message: 'Contract deleted successfully. Minimum balance has been freed.'
    });

  } catch (error) {
    console.error('❌ Error submitting delete transaction:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to submit delete transaction' 
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 RandCash API server running on port ${PORT}`);
  console.log(`Supported networks:`);
  Object.entries(NETWORK_CONFIGS).forEach(([key, config]) => {
    console.log(`  - ${config.name}: ${config.algodServer}`);
  });
  console.log(`📍 Health check: http://localhost:${PORT}/api/health`);
  console.log(`📧 Resend Email: ${isValidPicaConfig ? 'Configured' : 'Not configured (will simulate)'}`);
  console.log(`💰 Seed Wallet: ${seedWalletService.isConfigured ? 'Configured' : 'Not configured (seeding will be skipped)'}`);
});