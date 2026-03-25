import React, { useState, useCallback, useEffect } from "react";
import { 
  Upload, 
  FileText, 
  Download, 
  Loader2, 
  CheckCircle2, 
  AlertCircle,
  FileUp,
  X,
  Building2,
  Calendar,
  Hash,
  IndianRupee,
  User,
  LogOut,
  Shield,
  Trash2,
  UserCheck,
  UserX,
  Ban,
  RotateCcw
} from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { GoogleGenAI } from "@google/genai";
import * as pdfjs from "pdfjs-dist";
import { jsPDF } from "jspdf";
import "jspdf-autotable";
import { 
  generateTallyXml, 
  downloadXml, 
  validateTallyData,
  isDownloadSupported,
  type InvoiceData,
  type TallyValidationResult
} from "./lib/tallyXml";
import { auth, db } from "./firebase";
import { 
  signInWithPopup, 
  GoogleAuthProvider, 
  signOut, 
  onAuthStateChanged,
  type User as FirebaseUser
} from "firebase/auth";
import { 
  doc, 
  getDoc, 
  setDoc, 
  collection, 
  onSnapshot, 
  updateDoc, 
  deleteDoc,
  query,
  orderBy,
  serverTimestamp
} from "firebase/firestore";
import { useAuthState } from "react-firebase-hooks/auth";
import { useCollection } from "react-firebase-hooks/firestore";

// Set up pdf.js worker
pdfjs.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.js`;

interface HistoryItem extends InvoiceData {
  id: string;
  timestamp: number;
  fileName: string;
}

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const PdfPreview = ({ file }: { file: File }) => {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(true);

  React.useEffect(() => {
    const renderPdf = async () => {
      try {
        setLoading(true);
        const arrayBuffer = await file.arrayBuffer();
        const loadingTask = pdfjs.getDocument({ data: arrayBuffer });
        const pdf = await loadingTask.promise;
        const page = await pdf.getPage(1);
        
        const canvas = canvasRef.current;
        if (!canvas) return;
        
        const context = canvas.getContext("2d");
        if (!context) return;

        // Calculate scale to fit width while maintaining aspect ratio
        const containerWidth = canvas.parentElement?.clientWidth || 800;
        const viewport = page.getViewport({ scale: 1.5 }); // Higher scale for better quality
        
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        
        const renderContext = {
          canvasContext: context,
          viewport: viewport,
        };
        await (page as any).render(renderContext).promise;
      } catch (err) {
        console.error("PDF Render Error:", err);
      } finally {
        setLoading(false);
      }
    };
    
    renderPdf();
  }, [file]);

  return (
    <div className="relative min-h-[200px] flex items-center justify-center bg-slate-100 rounded-xl overflow-hidden">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-50/50 z-10">
          <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
        </div>
      )}
      <canvas ref={canvasRef} className="w-full h-auto max-h-[500px] object-contain" />
    </div>
  );
};

export default function App() {
  const [user, loading, authError] = useAuthState(auth);
  const [userData, setUserData] = useState<any>(null);
  const [userLoading, setUserLoading] = useState(true);
  
  const [files, setFiles] = useState<File[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingIndex, setProcessingIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"process" | "history" | "admin">("process");
  const [history, setHistory] = useState<HistoryItem[]>(() => {
    const saved = localStorage.getItem("invoice_history");
    return saved ? JSON.parse(saved) : [];
  });
  const [formData, setFormData] = useState<InvoiceData>({
    vendorName: "",
    invoiceNumber: "",
    invoiceDate: "",
    totalAmount: "",
    taxAmount: "",
    items: [],
  });
  const [validationErrors, setValidationErrors] = useState<{ [key: string]: string }>({});
  const [tallyValidation, setTallyValidation] = useState<TallyValidationResult | null>(null);

  // Fetch user data from Firestore
  useEffect(() => {
    if (user) {
      const userRef = doc(db, "users", user.uid);
      const unsubscribe = onSnapshot(userRef, (docSnap) => {
        if (docSnap.exists()) {
          setUserData(docSnap.data());
        } else {
          // Create user profile if it doesn't exist
          const isDefaultAdmin = user.email === "anuj06993@gmail.com";
          const newUserData = {
            email: user.email,
            isActive: true,
            role: isDefaultAdmin ? "admin" : "user",
            createdAt: serverTimestamp(),
          };
          setDoc(userRef, newUserData);
          setUserData(newUserData);
        }
        setUserLoading(false);
      }, (err) => {
        console.error("Error fetching user data:", err);
        setUserLoading(false);
      });
      return () => unsubscribe();
    } else {
      setUserData(null);
      setUserLoading(false);
    }
  }, [user]);

  // Save history to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem("invoice_history", JSON.stringify(history));
  }, [history]);

  const handleLogin = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (err: any) {
      console.error("Login Error:", err);
      setError(err.message);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      setActiveTab("process");
    } catch (err: any) {
      console.error("Logout Error:", err);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(e.target.files || []) as File[];
    if (selectedFiles.length > 0) {
      processFiles(selectedFiles);
    }
  };

  const processFiles = (selectedFiles: File[]) => {
    setFiles(prev => [...prev, ...selectedFiles]);
    setError(null);
    
    // Create preview for the first new file if none exists
    if (!previewUrl && selectedFiles[0]) {
      updatePreview(selectedFiles[0]);
    }
  };

  const updatePreview = (file: File) => {
    if (file.type.startsWith("image/")) {
      const url = URL.createObjectURL(file);
      setPreviewUrl(url);
    } else if (file.type === "application/pdf") {
      setPreviewUrl("pdf");
    } else {
      setPreviewUrl(null);
    }
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const droppedFiles = Array.from(e.dataTransfer.files || []) as File[];
    if (droppedFiles.length > 0) {
      processFiles(droppedFiles);
    }
  }, [previewUrl]);

  const handleExtract = async () => {
    if (files.length === 0) return;

    setIsProcessing(true);
    setError(null);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
      
      for (let i = 0; i < files.length; i++) {
        setProcessingIndex(i);
        const currentFile = files[i];
        
        // Convert file to base64
        const reader = new FileReader();
        const base64Promise = new Promise<string>((resolve, reject) => {
          reader.onload = () => {
            const base64 = (reader.result as string).split(",")[1];
            resolve(base64);
          };
          reader.onerror = reject;
        });
        reader.readAsDataURL(currentFile);
        const base64Data = await base64Promise;

        const prompt = 'Analyze this invoice image. Extract the header details AND all line items from the invoice. Return ONLY a valid JSON object strictly in this format without markdown: { "vendorName": "...", "invoiceNumber": "...", "invoiceDate": "YYYY-MM-DD", "totalAmount": "...", "taxAmount": "...", "items": [ { "itemName": "...", "qty": "...", "rate": "...", "amount": "..." } ] }';

        const result = await ai.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: [
            {
              parts: [
                { text: prompt },
                {
                  inlineData: {
                    data: base64Data,
                    mimeType: currentFile.type,
                  },
                },
              ],
            },
          ],
          config: {
            responseMimeType: "application/json",
          },
        });

        const text = result.text;
        if (!text) continue;

        const data = JSON.parse(text);
        
        const newInvoiceData: InvoiceData = {
          vendorName: data.vendorName || "",
          invoiceNumber: data.invoiceNumber || "",
          invoiceDate: data.invoiceDate || "",
          totalAmount: data.totalAmount || "",
          taxAmount: data.taxAmount || "",
          items: data.items || [],
        };
        
        // Update form data with the last processed item
        setFormData(newInvoiceData);

        // Add to history
        const historyItem: HistoryItem = {
          ...newInvoiceData,
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          fileName: currentFile.name,
        };
        setHistory(prev => [historyItem, ...prev]);
      }
      
      // Clear files after successful batch processing
      setFiles([]);
      setPreviewUrl(null);
      setProcessingIndex(null);
      alert(`Successfully processed ${files.length} invoices.`);

    } catch (err: any) {
      console.error("Extraction Error:", err);
      setError(err.message || "An error occurred during extraction");
    } finally {
      setIsProcessing(false);
      setProcessingIndex(null);
    }
  };

  const validateForm = (): boolean => {
    const errors: { [key: string]: string } = {};

    // Validate Date (YYYY-MM-DD or DD-MMM-YYYY)
    const dateRegex = /^\d{4}-\d{2}-\d{2}$|^\d{2}-[A-Za-z]{3}-\d{4}$/;
    if (!formData.invoiceDate) {
      errors.invoiceDate = "Invoice date is required";
    } else if (!dateRegex.test(formData.invoiceDate)) {
      errors.invoiceDate = "Invalid format (e.g. 2026-03-25)";
    }

    // Validate Amounts
    const cleanTotal = formData.totalAmount.replace(/,/g, "");
    if (!formData.totalAmount) {
      errors.totalAmount = "Total amount is required";
    } else if (isNaN(Number(cleanTotal))) {
      errors.totalAmount = "Must be a valid number";
    }

    const cleanTax = formData.taxAmount.replace(/,/g, "");
    if (!formData.taxAmount) {
      errors.taxAmount = "Tax amount is required";
    } else if (isNaN(Number(cleanTax))) {
      errors.taxAmount = "Must be a valid number";
    }

    if (!formData.vendorName) {
      errors.vendorName = "Vendor name is required";
    }

    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleDownload = () => {
    if (!validateForm()) return;
    
    const validation = validateTallyData(formData);
    setTallyValidation(validation);

    if (!validation.isValid) {
      setError("Tally validation failed. Please check the issues below.");
      return;
    }

    try {
      if (!isDownloadSupported()) {
        setError("Your browser does not support file downloads. Please use a desktop browser like Chrome or Firefox.");
        return;
      }

      const xml = generateTallyXml(formData);
      downloadXml(xml);
      // Optional: Show success message
      alert("Tally XML has been generated and download started!");
    } catch (err: any) {
      setError("Failed to generate or download XML: " + err.message);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    
    if (name === "invoiceDate") {
      // Format as DD-MMM-YYYY as user types
      const cleanValue = value.replace(/[^a-zA-Z0-9]/g, "");
      let formatted = "";
      
      if (cleanValue.length > 0) {
        formatted += cleanValue.substring(0, 2);
      }
      if (cleanValue.length > 2) {
        formatted += "-" + cleanValue.substring(2, 5);
      }
      if (cleanValue.length > 5) {
        formatted += "-" + cleanValue.substring(5, 9);
      }

      // Capitalize month part (e.g., mar -> Mar)
      if (formatted.includes("-")) {
        const parts = formatted.split("-");
        if (parts[1] && parts[1].length > 0) {
          parts[1] = parts[1].toUpperCase();
        }
        if (parts[2]) {
          parts[2] = parts[2].toUpperCase();
        }
        formatted = parts.join("-");
      }

      setFormData(prev => ({ ...prev, [name]: formatted.slice(0, 11) }));
      return;
    }

    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const deleteHistoryItem = (id: string) => {
    setHistory(prev => prev.filter(item => item.id !== id));
  };

  const downloadHistoryItem = (item: HistoryItem) => {
    const xml = generateTallyXml(item);
    downloadXml(xml, `Tally_${item.invoiceNumber || "Export"}.xml`);
  };

  const generateTallyPDF = () => {
    if (!validateForm()) return;

    // 1. Data ko Tally template me bharo (Using React state directly)
    const vendorNameEl = document.getElementById('pdf-vendor-name');
    const invoiceNoEl = document.getElementById('pdf-invoice-no');
    const invoiceDateEl = document.getElementById('pdf-invoice-date');
    const totalEl = document.getElementById('pdf-total');
    const taxEl = document.getElementById('pdf-tax');

    if (vendorNameEl) vendorNameEl.innerText = formData.vendorName;
    if (invoiceNoEl) invoiceNoEl.innerText = formData.invoiceNumber;
    if (invoiceDateEl) invoiceDateEl.innerText = formData.invoiceDate;
    if (totalEl) totalEl.innerText = formData.totalAmount;
    if (taxEl) taxEl.innerText = formData.taxAmount;

    // 2. Print ka jadoo (Sirf us div ko print karo)
    const printArea = document.getElementById('tally-print-area');
    if (!printArea) return;

    const printContent = printArea.innerHTML;
    const originalContent = document.body.innerHTML;

    document.body.innerHTML = printContent;
    window.print(); // Ye PDF save karne ka popup khol dega
    document.body.innerHTML = originalContent; // Print ke baad wapas normal app dikhao
    
    // Page reload taaki buttons wapas kaam karein
    window.location.reload(); 
  };

  const canProcess = userData?.role === "admin" || userData?.role === "editor";
  const canManage = userData?.role === "admin";
  const canViewHistory = !!userData; // All roles can view history

  useEffect(() => {
    if (userData && activeTab === "process" && !canProcess) {
      setActiveTab("history");
    }
    if (userData && activeTab === "admin" && !canManage) {
      setActiveTab("history");
    }
  }, [userData, activeTab, canProcess, canManage]);

  if (loading || userLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-12 h-12 text-blue-600 animate-spin" />
          <p className="text-slate-600 font-medium">Loading Telus Digital SaaS...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-3xl shadow-xl border border-slate-200 p-8 space-y-8 text-center">
          <div className="flex flex-col items-center gap-4">
            <div className="bg-blue-600 p-4 rounded-2xl shadow-lg shadow-blue-200">
              <FileText className="text-white w-10 h-10" />
            </div>
            <div className="space-y-2">
              <h1 className="text-3xl font-bold text-slate-900">Telus Digital</h1>
              <p className="text-slate-500">AI-Powered Tally Invoice Extractor</p>
            </div>
          </div>

          <div className="space-y-4">
            <button
              onClick={handleLogin}
              className="w-full flex items-center justify-center gap-3 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 font-semibold py-4 rounded-xl transition-all shadow-sm"
            >
              <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" className="w-5 h-5" alt="Google" />
              Sign in with Google
            </button>
            <p className="text-xs text-slate-400">
              By signing in, you agree to our Terms of Service and Privacy Policy.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (userData && !userData.isActive) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-3xl shadow-xl border border-red-100 p-8 space-y-6 text-center">
          <div className="bg-red-100 w-20 h-20 rounded-full flex items-center justify-center mx-auto">
            <AlertCircle className="w-10 h-10 text-red-600" />
          </div>
          <div className="space-y-2">
            <h1 className="text-2xl font-bold text-slate-900">Account Blocked</h1>
            <p className="text-slate-500">
              Your account has been blocked by the administrator. Please contact support for assistance.
            </p>
          </div>
          <button
            onClick={handleLogout}
            className="w-full bg-slate-900 hover:bg-slate-800 text-white font-semibold py-3 rounded-xl transition-all"
          >
            Sign Out
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#1E293B] font-sans">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 px-8 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="bg-blue-600 p-2 rounded-lg">
            <FileText className="text-white w-6 h-6" />
          </div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900">
            Telus <span className="text-blue-600">Digital</span>
          </h1>
        </div>
        <div className="flex items-center gap-6">
          <nav className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl">
            {canProcess && (
              <button
                onClick={() => setActiveTab("process")}
                className={cn(
                  "px-4 py-2 rounded-lg text-sm font-semibold transition-all",
                  activeTab === "process" ? "bg-white text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
                )}
              >
                Process Invoice
              </button>
            )}
            <button
              onClick={() => setActiveTab("history")}
              className={cn(
                "px-4 py-2 rounded-lg text-sm font-semibold transition-all flex items-center gap-2",
                activeTab === "history" ? "bg-white text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
              )}
            >
              History
              {history.length > 0 && (
                <span className="bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded-md text-[10px]">
                  {history.length}
                </span>
              )}
            </button>
            {canManage && (
              <button
                onClick={() => setActiveTab("admin")}
                className={cn(
                  "px-4 py-2 rounded-lg text-sm font-semibold transition-all flex items-center gap-2",
                  activeTab === "admin" ? "bg-white text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
                )}
              >
                <Shield className="w-4 h-4" />
                Admin
              </button>
            )}
          </nav>
          
          <div className="flex items-center gap-4 border-l border-slate-200 pl-6">
            <div className="flex flex-col items-end">
              <span className="text-sm font-bold text-slate-900">{user.displayName || user.email}</span>
              <span className="text-[10px] font-bold uppercase tracking-widest text-blue-600">{userData?.role}</span>
            </div>
            <button
              onClick={handleLogout}
              className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
              title="Sign Out"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      <main className="h-[calc(100vh-73px)] overflow-hidden">
        {activeTab === "process" ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 h-full">
            {/* Left Section: Upload & Preview */}
            <section className="p-8 overflow-y-auto border-r border-slate-200 bg-white">
              <div className="max-w-xl mx-auto space-y-8">
                <div className="space-y-2">
                  <h2 className="text-2xl font-semibold text-slate-900">Upload Invoice</h2>
                  <p className="text-slate-500">Drag and drop your PDF or image invoice for AI processing.</p>
                </div>

                <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={onDrop}
                  className={cn(
                    "relative group border-2 border-dashed rounded-2xl p-12 transition-all duration-300 flex flex-col items-center justify-center gap-4 text-center cursor-pointer",
                    files.length > 0 ? "border-blue-200 bg-blue-50/30" : "border-slate-200 hover:border-blue-400 hover:bg-slate-50"
                  )}
                  onClick={() => document.getElementById("file-upload")?.click()}
                >
                  <input
                    id="file-upload"
                    type="file"
                    multiple
                    className="hidden"
                    accept=".pdf,image/*"
                    onChange={handleFileChange}
                  />
                  
                  {files.length > 0 ? (
                    <div className="flex flex-col items-center gap-4 w-full">
                      <div className="bg-blue-100 p-4 rounded-full">
                        <CheckCircle2 className="w-8 h-8 text-blue-600" />
                      </div>
                      <div className="w-full max-h-[200px] overflow-y-auto space-y-2 px-4">
                        {files.map((f, idx) => (
                          <div key={idx} className="flex items-center justify-between bg-white p-2 rounded-lg border border-blue-100 shadow-sm">
                            <div className="flex items-center gap-2 overflow-hidden">
                              <FileText className="w-4 h-4 text-blue-500 shrink-0" />
                              <span className="text-sm font-medium text-slate-900 truncate">{f.name}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              {isProcessing && processingIndex === idx && (
                                <Loader2 className="w-4 h-4 text-blue-600 animate-spin" />
                              )}
                              {isProcessing && processingIndex !== null && processingIndex > idx && (
                                <CheckCircle2 className="w-4 h-4 text-green-500" />
                              )}
                              {!isProcessing && (
                                <button 
                                  onClick={(e) => { 
                                    e.stopPropagation(); 
                                    const newFiles = [...files];
                                    newFiles.splice(idx, 1);
                                    setFiles(newFiles);
                                    if (newFiles.length === 0) setPreviewUrl(null);
                                    else if (processingIndex === idx || idx === 0) updatePreview(newFiles[0]);
                                  }}
                                  className="text-red-500 hover:text-red-600"
                                >
                                  <X className="w-4 h-4" />
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                      {!isProcessing && (
                        <button 
                          onClick={(e) => { e.stopPropagation(); setFiles([]); setPreviewUrl(null); }}
                          className="text-sm text-red-500 hover:text-red-600 font-medium flex items-center gap-1"
                        >
                          <X className="w-4 h-4" /> Remove All
                        </button>
                      )}
                    </div>
                  ) : (
                    <>
                      <div className="bg-slate-100 p-4 rounded-full group-hover:bg-blue-100 transition-colors">
                        <FileUp className="w-8 h-8 text-slate-400 group-hover:text-blue-600" />
                      </div>
                      <div>
                        <p className="font-medium text-slate-900">Click to upload or drag and drop</p>
                        <p className="text-sm text-slate-500">PDF, PNG, JPG up to 10MB (Multiple allowed)</p>
                      </div>
                    </>
                  )}
                </div>

                {previewUrl && files.length > 0 && (
                  <div className="space-y-4">
                    <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-400">Preview</h3>
                    <div className="rounded-xl border border-slate-200 overflow-hidden bg-slate-50">
                      {previewUrl === "pdf" ? (
                        <PdfPreview file={files[0]} />
                      ) : (
                        <img src={previewUrl} alt="Invoice Preview" className="w-full h-auto max-h-[400px] object-contain" />
                      )}
                    </div>
                  </div>
                )}

                {files.length > 0 && !isProcessing && (
                  <button
                    onClick={handleExtract}
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-4 rounded-xl shadow-lg shadow-blue-200 transition-all flex items-center justify-center gap-2"
                  >
                    Extract {files.length} {files.length === 1 ? 'Invoice' : 'Invoices'} with AI
                  </button>
                )}

                {isProcessing && (
                  <div className="flex flex-col items-center justify-center py-12 gap-4">
                    <Loader2 className="w-10 h-10 text-blue-600 animate-spin" />
                    <p className="text-slate-600 font-medium animate-pulse">
                      Processing {processingIndex !== null ? processingIndex + 1 : 0} of {files.length}...
                    </p>
                  </div>
                )}

                {error && (
                  <div className="bg-red-50 border border-red-100 p-4 rounded-xl flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                    <div className="text-sm text-red-700">
                      <p className="font-semibold">Processing Error</p>
                      <p>{error}</p>
                    </div>
                  </div>
                )}
              </div>
            </section>

            {/* Right Section: Form & Export */}
            <section className="p-8 overflow-y-auto bg-[#F1F5F9]">
              <div className="max-w-xl mx-auto space-y-8">
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <h2 className="text-2xl font-semibold text-slate-900">Invoice Details</h2>
                    <p className="text-slate-500">Review and edit the extracted information.</p>
                  </div>
                  {formData.vendorName && (
                    <div className="bg-green-100 text-green-700 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider">
                      Extracted
                    </div>
                  )}
                </div>

                <div className="bg-white rounded-2xl p-8 shadow-sm border border-slate-200 space-y-6">
                  <div className="grid grid-cols-1 gap-6">
                    <div className="space-y-2">
                      <label className="text-sm font-semibold text-slate-600 flex items-center gap-2">
                        <Building2 className="w-4 h-4" /> Vendor Name
                      </label>
                      <input
                        type="text"
                        id="vendorName"
                        name="vendorName"
                        value={formData.vendorName}
                        onChange={handleInputChange}
                        placeholder="e.g. Amazon Web Services"
                        className={cn(
                          "w-full px-4 py-3 rounded-xl border focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all",
                          validationErrors.vendorName ? "border-red-500 bg-red-50" : "border-slate-200"
                        )}
                      />
                      {validationErrors.vendorName && (
                        <p className="text-xs text-red-500 font-medium">{validationErrors.vendorName}</p>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <label className="text-sm font-semibold text-slate-600 flex items-center gap-2">
                          <Hash className="w-4 h-4" /> Invoice Number
                        </label>
                        <input
                          type="text"
                          id="invoiceNumber"
                          name="invoiceNumber"
                          value={formData.invoiceNumber}
                          onChange={handleInputChange}
                          placeholder="INV-001"
                          className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-semibold text-slate-600 flex items-center gap-2">
                          <Calendar className="w-4 h-4" /> Invoice Date
                        </label>
                        <input
                          type="text"
                          id="invoiceDate"
                          name="invoiceDate"
                          value={formData.invoiceDate}
                          onChange={handleInputChange}
                          placeholder="YYYY-MM-DD"
                          className={cn(
                            "w-full px-4 py-3 rounded-xl border focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all",
                            validationErrors.invoiceDate ? "border-red-500 bg-red-50" : "border-slate-200"
                          )}
                        />
                        {validationErrors.invoiceDate && (
                          <p className="text-xs text-red-500 font-medium">{validationErrors.invoiceDate}</p>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <label className="text-sm font-semibold text-slate-600 flex items-center gap-2">
                          <IndianRupee className="w-4 h-4" /> Total Amount
                        </label>
                        <input
                          type="text"
                          id="totalAmount"
                          name="totalAmount"
                          value={formData.totalAmount}
                          onChange={handleInputChange}
                          placeholder="0.00"
                          className={cn(
                            "w-full px-4 py-3 rounded-xl border focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all font-mono",
                            validationErrors.totalAmount ? "border-red-500 bg-red-50" : "border-slate-200"
                          )}
                        />
                        {validationErrors.totalAmount && (
                          <p className="text-xs text-red-500 font-medium">{validationErrors.totalAmount}</p>
                        )}
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-semibold text-slate-600 flex items-center gap-2">
                          <IndianRupee className="w-4 h-4" /> Tax Amount
                        </label>
                        <input
                          type="text"
                          id="taxAmount"
                          name="taxAmount"
                          value={formData.taxAmount}
                          onChange={handleInputChange}
                          placeholder="0.00"
                          className={cn(
                            "w-full px-4 py-3 rounded-xl border focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all font-mono",
                            validationErrors.taxAmount ? "border-red-500 bg-red-50" : "border-slate-200"
                          )}
                        />
                        {validationErrors.taxAmount && (
                          <p className="text-xs text-red-500 font-medium">{validationErrors.taxAmount}</p>
                        )}
                      </div>
                    </div>

                    {/* Line Items Section */}
                    {formData.items && formData.items.length > 0 && (
                      <div className="space-y-4 pt-4 border-t border-slate-100">
                        <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider">Line Items</h3>
                        <div className="space-y-3">
                          {formData.items.map((item, idx) => (
                            <div key={idx} className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
                              <div className="flex justify-between items-start gap-4">
                                <span className="text-sm font-bold text-slate-900 flex-1">{item.itemName}</span>
                                <span className="text-sm font-mono font-bold text-blue-600">₹{item.amount}</span>
                              </div>
                              <div className="flex gap-4 text-xs text-slate-500 font-medium">
                                <span>Qty: {item.qty}</span>
                                <span>Rate: ₹{item.rate}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="pt-4 space-y-4">
                    {tallyValidation && (tallyValidation.errors.length > 0 || tallyValidation.warnings.length > 0) && (
                      <div className={cn(
                        "p-4 rounded-xl border text-sm space-y-2",
                        tallyValidation.errors.length > 0 ? "bg-red-50 border-red-100 text-red-800" : "bg-amber-50 border-amber-100 text-amber-800"
                      )}>
                        <div className="flex items-center gap-2 font-bold uppercase tracking-wider text-[10px]">
                          {tallyValidation.errors.length > 0 ? (
                            <><AlertCircle className="w-3 h-3" /> Critical Issues</>
                          ) : (
                            <><AlertCircle className="w-3 h-3" /> Tally Compatibility Warnings</>
                          )}
                        </div>
                        <ul className="list-disc list-inside space-y-1">
                          {tallyValidation.errors.map((err, i) => (
                            <li key={i}>{err}</li>
                          ))}
                          {tallyValidation.warnings.map((warn, i) => (
                            <li key={i}>{warn}</li>
                          ))}
                        </ul>
                        {tallyValidation.errors.length === 0 && (
                          <p className="text-[11px] italic opacity-80 pt-1 border-t border-amber-200 mt-2">
                            You can still download the XML, but Tally might require manual ledger creation.
                          </p>
                        )}
                      </div>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <button
                        disabled={!formData.vendorName}
                        onClick={handleDownload}
                        className="w-full bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 text-white font-semibold py-4 rounded-xl transition-all flex items-center justify-center gap-2 shadow-lg"
                      >
                        <Download className="w-5 h-5" />
                        Generate & Download Tally XML
                      </button>
                      <button 
                        disabled={!formData.vendorName}
                        onClick={generateTallyPDF} 
                        className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white font-semibold py-4 rounded-xl transition-all flex items-center justify-center gap-2 shadow-lg"
                      >
                        <Download className="w-5 h-5" />
                        Download Tally Invoice (PDF)
                      </button>
                    </div>
                  </div>
                </div>

                <div className="bg-blue-50 border border-blue-100 p-6 rounded-2xl space-y-3">
                  <h4 className="text-sm font-bold text-blue-900 uppercase tracking-wider">Tally Integration Guide</h4>
                  <ul className="text-sm text-blue-800 space-y-2 list-disc list-inside">
                    <li>Open Tally ERP 9 / Prime</li>
                    <li>Go to <strong>Import Data</strong> &gt; <strong>Vouchers</strong></li>
                    <li>Select the downloaded <strong>Tally_Import.xml</strong></li>
                    <li><strong>Error: "Ledger not found"?</strong> Ensure the Vendor Name matches exactly in Tally.</li>
                    <li><strong>Error: "Date out of range"?</strong> Check your Tally Financial Year settings.</li>
                  </ul>
                </div>
              </div>
            </section>
          </div>
        ) : activeTab === "history" ? (
          <section className="p-8 h-full overflow-y-auto bg-[#F8FAFC]">
            <div className="max-w-5xl mx-auto space-y-8">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <h2 className="text-2xl font-semibold text-slate-900">Processing History</h2>
                  <p className="text-slate-500">View and re-download previously processed invoices.</p>
                </div>
                {history.length > 0 && (
                  <button 
                    onClick={() => { if(confirm("Clear all history?")) setHistory([]); }}
                    className="text-sm text-red-500 hover:text-red-600 font-medium"
                  >
                    Clear All
                  </button>
                )}
              </div>

              {history.length === 0 ? (
                <div className="bg-white rounded-2xl p-12 border border-slate-200 text-center space-y-4">
                  <div className="bg-slate-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto">
                    <FileText className="w-8 h-8 text-slate-400" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-lg font-semibold text-slate-900">No history yet</p>
                    <p className="text-slate-500">Processed invoices will appear here for quick access.</p>
                  </div>
                  <button 
                    onClick={() => setActiveTab("process")}
                    className="text-blue-600 font-semibold hover:underline"
                  >
                    Start processing an invoice
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-4">
                  {history.map((item) => (
                    <div 
                      key={item.id}
                      className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm hover:shadow-md transition-all flex items-center justify-between group"
                    >
                      <div className="flex items-center gap-4">
                        <div className="bg-blue-50 p-3 rounded-xl">
                          <FileText className="w-6 h-6 text-blue-600" />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="font-bold text-slate-900">{item.vendorName || "Unknown Vendor"}</h3>
                            <span className="text-xs text-slate-400">•</span>
                            <span className="text-xs font-mono text-slate-500">{item.invoiceNumber}</span>
                          </div>
                          <div className="flex items-center gap-3 text-sm text-slate-500 mt-1">
                            <span className="flex items-center gap-1">
                              <Calendar className="w-3 h-3" /> {item.invoiceDate}
                            </span>
                            <span className="flex items-center gap-1">
                              <IndianRupee className="w-3 h-3" /> {item.totalAmount}
                            </span>
                            <span className="text-xs bg-slate-100 px-2 py-0.5 rounded italic">
                              {item.fileName}
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => downloadHistoryItem(item)}
                          className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                          title="Download XML"
                        >
                          <Download className="w-5 h-5" />
                        </button>
                        <button
                          onClick={() => deleteHistoryItem(item.id)}
                          className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
                          title="Delete"
                        >
                          <X className="w-5 h-5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        ) : (
          <AdminDashboard userData={userData} />
        )}
      </main>

      {/* Hidden Tally Template for PDF Generation */}
      <div id="tally-print-area" style={{ display: 'none', padding: '20px', fontFamily: 'Arial, sans-serif', color: 'black', background: 'white', position: 'relative' }}>
        <div style={{ border: '2px solid black', padding: '15px', position: 'relative', overflow: 'hidden' }}>
          {/* Subtle Watermark */}
          <div style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%) rotate(-45deg)',
            fontSize: '100px',
            fontWeight: 'bold',
            color: 'rgba(0,0,0,0.03)',
            pointerEvents: 'none',
            zIndex: 0,
            whiteSpace: 'nowrap',
            textTransform: 'uppercase'
          }}>
            Telus Digital
          </div>

          <h2 style={{ textAlign: 'center', margin: 0, borderBottom: '2px solid black', paddingBottom: '10px', position: 'relative', zIndex: 1 }}>TAX INVOICE</h2>
          
          <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '2px solid black', padding: '10px 0', position: 'relative', zIndex: 1 }}>
            <div style={{ width: '50%', borderRight: '2px solid black' }}>
              <strong>Billed From (Seller):</strong><br />
              <span id="pdf-vendor-name" style={{ fontSize: '16px', fontWeight: 'bold' }}>Vendor Name</span>
            </div>
            <div style={{ width: '50%', paddingLeft: '10px' }}>
              <div style={{ marginBottom: '10px' }}>
                <strong>Billed To (Buyer):</strong><br />
                <span style={{ fontSize: '16px', fontWeight: 'bold' }}>Telus Digital</span>
              </div>
              <strong>Invoice No:</strong> <span id="pdf-invoice-no">12345</span><br />
              <strong>Date:</strong> <span id="pdf-invoice-date">DD-MMM-YYYY</span>
            </div>
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '10px', position: 'relative', zIndex: 1 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid black' }}>
                <th style={{ textAlign: 'left', padding: '5px', borderRight: '1px solid black' }}>Description</th>
                <th style={{ textAlign: 'right', padding: '5px', borderRight: '1px solid black' }}>Tax (₹)</th>
                <th style={{ textAlign: 'right', padding: '5px' }}>Total Amount (₹)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ padding: '40px 5px', borderRight: '1px solid black', verticalAlign: 'top' }}>
                  Goods / Services As per original bill<br />
                  <span style={{ fontSize: '10px', color: '#666' }}>Imported via AI Invoice Extractor</span>
                </td>
                <td id="pdf-tax" style={{ textAlign: 'right', padding: '10px 5px', borderRight: '1px solid black', verticalAlign: 'top' }}>0.00</td>
                <td id="pdf-total" style={{ textAlign: 'right', padding: '10px 5px', verticalAlign: 'top' }}>0.00</td>
              </tr>
            </tbody>
          </table>
          
          <div style={{ borderTop: '2px solid black', marginTop: '40px', textAlign: 'right', paddingTop: '10px', position: 'relative', zIndex: 1 }}>
            <div style={{ marginBottom: '40px' }}>For <strong>Telus Digital</strong></div>
            <strong>Authorized Signatory</strong>
          </div>
        </div>
      </div>
    </div>
  );
}

function AdminDashboard({ userData }: { userData: any }) {
  const [values, loading, error] = useCollection(
    query(collection(db, "users"), orderBy("createdAt", "desc"))
  );
  const [searchTerm, setSearchTerm] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "blocked">("all");

  const [confirmAction, setConfirmAction] = useState<{
    type: "block" | "unblock" | "delete" | "role";
    userId: string;
    data?: any;
  } | null>(null);

  const toggleUserStatus = async (userId: string, currentStatus: boolean, targetRole: string) => {
    if (targetRole === "admin" && userData?.email !== "anuj06993@gmail.com") {
      alert("Only the Super Admin can block other Admins.");
      return;
    }
    try {
      await updateDoc(doc(db, "users", userId), {
        isActive: !currentStatus
      });
      setConfirmAction(null);
    } catch (err) {
      console.error("Error toggling status:", err);
    }
  };

  const updateUserRole = async (userId: string, newRole: string, targetEmail: string) => {
    if (userData?.role !== "admin") {
      alert("Only Admins can change user roles.");
      return;
    }
    
    if (newRole === "admin" && userData?.email !== "anuj06993@gmail.com") {
      alert("Only the Super Admin can promote users to Admin.");
      return;
    }
    
    try {
      await updateDoc(doc(db, "users", userId), {
        role: newRole
      });
      setConfirmAction(null);
    } catch (err) {
      console.error("Error updating role:", err);
    }
  };

  const deleteUser = async (userId: string, targetRole: string) => {
    if (targetRole === "admin" && userData?.email !== "anuj06993@gmail.com") {
      alert("Only the Super Admin can delete other Admins.");
      return;
    }
    try {
      await deleteDoc(doc(db, "users", userId));
      setConfirmAction(null);
    } catch (err) {
      console.error("Error deleting user:", err);
    }
  };

  if (loading) return <div className="p-8 text-center text-slate-500">Loading users...</div>;
  if (error) return <div className="p-8 text-center text-red-500">Error: {error.message}</div>;

  const filteredDocs = values?.docs.filter(doc => {
    const data = doc.data();
    const matchesSearch = data.email?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesFilter = 
      filter === "all" ? true :
      filter === "active" ? data.isActive === true :
      data.isActive === false;
    return matchesSearch && matchesFilter;
  });

  return (
    <section className="p-8 h-full overflow-y-auto bg-[#F8FAFC]">
      <div className="max-w-6xl mx-auto space-y-8">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-2xl font-semibold text-slate-900">Admin Dashboard</h2>
            <p className="text-slate-500">Manage user access and account status.</p>
          </div>
          
          <div className="flex items-center gap-3">
            <div className="relative">
              <Hash className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                placeholder="Search by email..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10 pr-4 py-2 bg-white border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 outline-none w-64 transition-all"
              />
            </div>
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value as any)}
              className="bg-white border border-slate-200 rounded-xl px-4 py-2 text-sm font-semibold text-slate-600 outline-none focus:ring-2 focus:ring-blue-500 transition-all"
            >
              <option value="all">All Users</option>
              <option value="active">Active Only</option>
              <option value="blocked">Blocked Only</option>
            </select>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[800px]">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-slate-500">User Email</th>
                <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-slate-500">Role</th>
                <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-slate-500">Status</th>
                <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-slate-500 text-center">Manage Access</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredDocs?.map((doc) => {
                const data = doc.data();
                const isMe = doc.id === auth.currentUser?.uid;
                return (
                  <tr key={doc.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="bg-slate-100 p-2 rounded-full">
                          <User className="w-4 h-4 text-slate-500" />
                        </div>
                        <span className="font-medium text-slate-900">{data.email}</span>
                        {isMe && <span className="text-[10px] bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded font-bold ml-2">YOU</span>}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      {isMe ? (
                        <span className={cn(
                          "text-xs font-bold px-2.5 py-1 rounded-full uppercase tracking-wider",
                          data.role === "admin" ? "bg-purple-100 text-purple-700" : 
                          data.role === "editor" ? "bg-blue-100 text-blue-700" :
                          data.role === "viewer" ? "bg-amber-100 text-amber-700" :
                          "bg-slate-100 text-slate-600"
                        )}>
                          {data.role}
                        </span>
                      ) : (
                        <div className="relative inline-block">
                          <select
                            value={data.role}
                            onChange={(e) => updateUserRole(doc.id, e.target.value, data.email)}
                            className={cn(
                              "appearance-none text-xs font-bold rounded-lg px-3 py-1.5 pr-8 outline-none focus:ring-2 focus:ring-blue-500 border transition-all cursor-pointer",
                              data.role === "admin" ? "bg-purple-50 border-purple-200 text-purple-700" : 
                              data.role === "editor" ? "bg-blue-50 border-blue-200 text-blue-700" :
                              data.role === "viewer" ? "bg-amber-50 border-amber-200 text-amber-700" :
                              "bg-slate-50 border-slate-200 text-slate-600"
                            )}
                          >
                            <option value="admin" disabled={userData?.email !== "anuj06993@gmail.com"}>Admin</option>
                            <option value="editor">Editor</option>
                            <option value="viewer">Viewer</option>
                            <option value="user">User</option>
                          </select>
                          <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none">
                            <svg className="w-3 h-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
                            </svg>
                          </div>
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        {data.isActive ? (
                          <span className="flex items-center gap-1 text-xs font-bold text-green-600 bg-green-50 px-2 py-1 rounded-md">
                            <UserCheck className="w-3 h-3" /> Active
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-xs font-bold text-red-600 bg-red-50 px-2 py-1 rounded-md">
                            <UserX className="w-3 h-3" /> Blocked
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center justify-center gap-3">
                        {data.isActive ? (
                          <button
                            disabled={isMe || (data.role === "admin" && userData?.email !== "anuj06993@gmail.com")}
                            onClick={() => setConfirmAction({ type: "block", userId: doc.id, data: { status: data.isActive, role: data.role } })}
                            className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold bg-red-600 text-white hover:bg-red-700 transition-all shadow-sm shadow-red-100 disabled:opacity-30 disabled:cursor-not-allowed"
                          >
                            <Ban className="w-4 h-4" />
                            Block User
                          </button>
                        ) : (
                          <button
                            disabled={isMe || (data.role === "admin" && userData?.email !== "anuj06993@gmail.com")}
                            onClick={() => setConfirmAction({ type: "unblock", userId: doc.id, data: { status: data.isActive, role: data.role } })}
                            className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold bg-green-600 text-white hover:bg-green-700 transition-all shadow-sm shadow-green-100 disabled:opacity-30 disabled:cursor-not-allowed"
                          >
                            <RotateCcw className="w-4 h-4" />
                            Unblock User
                          </button>
                        )}
                        <button
                          disabled={isMe || (data.role === "admin" && userData?.email !== "anuj06993@gmail.com")}
                          onClick={() => setConfirmAction({ type: "delete", userId: doc.id, data: { role: data.role } })}
                          className="p-2.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-xl transition-all disabled:opacity-30"
                          title="Delete User"
                        >
                          <Trash2 className="w-4.5 h-4.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Custom Confirmation Modal */}
        {confirmAction && (
          <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
            <div className="bg-white rounded-3xl shadow-2xl max-w-sm w-full p-8 space-y-6 animate-in fade-in zoom-in duration-200">
              <div className={cn(
                "w-16 h-16 rounded-2xl flex items-center justify-center mx-auto",
                confirmAction.type === "delete" || confirmAction.type === "block" ? "bg-red-100 text-red-600" : "bg-blue-100 text-blue-600"
              )}>
                {confirmAction.type === "delete" ? <Trash2 className="w-8 h-8" /> : 
                 confirmAction.type === "block" ? <Ban className="w-8 h-8" /> : 
                 <RotateCcw className="w-8 h-8" />}
              </div>
              
              <div className="text-center space-y-2">
                <h3 className="text-xl font-bold text-slate-900 capitalize">
                  {confirmAction.type} User?
                </h3>
                <p className="text-slate-500 text-sm">
                  {confirmAction.type === "delete" 
                    ? "This action is permanent and cannot be undone. All user data will be removed."
                    : `Are you sure you want to ${confirmAction.type} this user's access to the platform?`}
                </p>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setConfirmAction(null)}
                  className="flex-1 px-4 py-3 rounded-xl font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    if (confirmAction.type === "delete") deleteUser(confirmAction.userId, confirmAction.data.role);
                    else if (confirmAction.type === "block" || confirmAction.type === "unblock") toggleUserStatus(confirmAction.userId, confirmAction.data.status, confirmAction.data.role);
                  }}
                  className={cn(
                    "flex-1 px-4 py-3 rounded-xl font-semibold text-white transition-all",
                    confirmAction.type === "delete" || confirmAction.type === "block" ? "bg-red-600 hover:bg-red-700" : "bg-blue-600 hover:bg-blue-700"
                  )}
                >
                  Confirm
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
