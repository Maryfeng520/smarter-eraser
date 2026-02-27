import React, { useState, useRef, useEffect } from 'react';
import { Upload, Image as ImageIcon, Sparkles, Download, Trash2, Loader2 } from 'lucide-react';
import { GoogleGenAI } from '@google/genai';
import * as pdfjsLib from 'pdfjs-dist';
import { jsPDF } from 'jspdf';

// Initialize PDF.js worker
if (typeof window !== 'undefined' && 'Worker' in window) {
  try {
    pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
  } catch (e) {
    console.error('Failed to set PDF worker source:', e);
  }
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export default function App() {
  const [sourcePages, setSourcePages] = useState<string[]>([]);
  const [sourceMimeType, setSourceMimeType] = useState<string | null>(null);
  const [resultPages, setResultPages] = useState<string[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userPrompt, setUserPrompt] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const quickPrompts = [
    "擦除所有手写答案、填空、画图和标记。保留原始的空白问题、打印文本和文档结构。让它看起来像一张干净的空白试卷。",
    "清除图片中的红色批注和打分，保留黑色手写字和打印字。",
    "去除图片背景中的杂物和阴影，将背景变成纯白色，增强文字清晰度。",
    "擦除图片中的所有文字，只保留图片和表格等图形元素。"
  ];

  const [viewMode, setViewMode] = useState<'single' | 'compare'>('single');

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 100 * 1024 * 1024) {
      setError('文件大小不能超过 100MB');
      return;
    }

    setIsUploading(true);
    setError(null);
    setResultPages([]);
    setSourcePages([]);

    // Allow UI to render loading state
    await new Promise(resolve => setTimeout(resolve, 50));

    if (file.type === 'application/pdf') {
      try {
        const arrayBuffer = await file.arrayBuffer();
        const typedarray = new Uint8Array(arrayBuffer);
        const loadingTask = pdfjsLib.getDocument({ 
          data: typedarray,
          cMapUrl: `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/standard_fonts/`
        });
        const pdf = await loadingTask.promise;
        
        const pages: string[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const viewport = page.getViewport({ scale: 2.0 });
          
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d');
          if (!context) throw new Error('无法创建画布');
          
          canvas.height = viewport.height;
          canvas.width = viewport.width;
          
          // @ts-ignore
          await page.render({
            canvasContext: context,
            viewport: viewport
          }).promise;
          
          pages.push(canvas.toDataURL('image/png'));
        }
        
        setSourcePages(pages);
        setSourceMimeType('image/png');
      } catch (err: any) {
        console.error('Error reading PDF:', err);
        setError(`读取 PDF 文件时发生错误: ${err.message || '未知错误'}`);
      } finally {
        setIsUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    } else {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64String = reader.result as string;
        setSourcePages([base64String]);
        setSourceMimeType(file.type);
        setIsUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      };
      reader.readAsDataURL(file);
    }
  };

  const clearImage = () => {
    setSourcePages([]);
    setSourceMimeType(null);
    setResultPages([]);
    setError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const processImage = async () => {
    if (sourcePages.length === 0 || !sourceMimeType) return;

    setIsProcessing(true);
    setError(null);
    setResultPages([]);

    try {
      const results: string[] = [];
      for (let i = 0; i < sourcePages.length; i++) {
        const base64Data = sourcePages[i].split(',')[1];

        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash-image',
          contents: {
            parts: [
              {
                inlineData: {
                  data: base64Data,
                  mimeType: sourceMimeType,
                },
              },
              {
                text: `TASK: Image Editing.
INSTRUCTION: ${userPrompt.trim()}
REQUIREMENT: Output ONLY the edited image. Do not add any new elements not requested. Maintain the original resolution and style.`,
              },
            ],
          },
          config: {
            systemInstruction: "You are a professional document and image restoration expert. Your specialty is removing handwriting, marks, and annotations from scanned documents and photos while perfectly preserving the original printed text and background structure. You always output the modified image directly.",
          }
        });

        let foundImage = false;
        let textResponse = '';
        if (response.candidates && response.candidates[0]?.content?.parts) {
          for (const part of response.candidates[0].content.parts) {
            if (part.inlineData) {
              const base64EncodeString = part.inlineData.data;
              const imageUrl = `data:${part.inlineData.mimeType || 'image/png'};base64,${base64EncodeString}`;
              results.push(imageUrl);
              foundImage = true;
              break;
            } else if (part.text) {
              textResponse += part.text;
            }
          }
        }

        if (!foundImage) {
          throw new Error(`第 ${i + 1} 页未能生成图像。AI回复: ${textResponse || '无'}`);
        }
        
        // Update state progressively
        setResultPages([...results]);
      }
    } catch (err: any) {
      console.error('Error processing image:', err);
      setError(err.message || '处理图像时发生错误。');
    } finally {
      setIsProcessing(false);
    }
  };

  const downloadResult = () => {
    if (resultPages.length === 0) return;
    
    if (resultPages.length === 1) {
      const a = document.createElement('a');
      a.href = resultPages[0];
      a.download = 'cleaned_worksheet.png';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } else {
      const pdf = new jsPDF('p', 'mm', 'a4');
      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = pdf.internal.pageSize.getHeight();
      
      resultPages.forEach((pageData, index) => {
        if (index > 0) pdf.addPage();
        
        const imgProps = pdf.getImageProperties(pageData);
        const ratio = imgProps.width / imgProps.height;
        const pdfRatio = pdfWidth / pdfHeight;
        
        let finalWidth = pdfWidth;
        let finalHeight = pdfHeight;
        
        if (ratio > pdfRatio) {
          finalHeight = pdfWidth / ratio;
        } else {
          finalWidth = pdfHeight * ratio;
        }
        
        const x = (pdfWidth - finalWidth) / 2;
        const y = (pdfHeight - finalHeight) / 2;
        
        pdf.addImage(pageData, 'PNG', x, y, finalWidth, finalHeight);
      });
      
      pdf.save('cleaned_document.pdf');
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 font-sans selection:bg-indigo-100 selection:text-indigo-900">
      <header className="bg-white border-b border-zinc-200 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white shadow-sm">
              <Sparkles size={18} />
            </div>
            <h1 className="text-xl font-semibold tracking-tight">智能试卷擦除</h1>
          </div>
          <div className="text-sm text-zinc-500 font-medium hidden sm:block">
            Powered by Gemini 2.5 Flash
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8 max-w-2xl">
          <h2 className="text-3xl font-bold tracking-tight mb-3">一键擦除试卷答案</h2>
          <p className="text-zinc-600 text-lg leading-relaxed">
            上传带有手写答案或批注的试卷照片或PDF，AI 将智能识别并擦除所有作答痕迹，为您还原一张全新的空白试卷。
          </p>
        </div>

        <div className="mb-8 bg-white p-6 rounded-2xl border border-zinc-200 shadow-sm">
          <label className="block text-sm font-medium text-zinc-700 mb-2">
            清除需求说明 <span className="text-red-500">*</span> <span className="text-zinc-500 font-normal">(请详细描述您希望AI擦除或保留的内容)</span>
          </label>
          <textarea
            value={userPrompt}
            onChange={(e) => setUserPrompt(e.target.value)}
            className="w-full px-4 py-3 rounded-xl border border-zinc-300 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all resize-none text-zinc-800 mb-3"
            rows={3}
            placeholder="请输入您的具体需求，例如：擦除所有手写答案、填空、画图和标记。保留原始的空白问题、打印文本和文档结构。"
          />
          <div className="flex flex-wrap gap-2 items-center mb-3">
            <span className="text-xs text-zinc-500">快捷指令：</span>
            {quickPrompts.map((prompt, idx) => (
              <button
                key={idx}
                onClick={() => setUserPrompt(prompt)}
                className="text-xs bg-zinc-100 hover:bg-indigo-50 text-zinc-600 hover:text-indigo-600 px-3 py-1.5 rounded-full transition-colors text-left max-w-xs truncate"
                title={prompt}
              >
                {prompt}
              </button>
            ))}
          </div>
          <div className="text-xs text-amber-600 bg-amber-50 p-2 rounded-lg border border-amber-100 mb-3">
            <strong>提示：</strong> AI 图像编辑能力受限于模型本身。如果 AI 返回了文字错误（如拒绝处理），通常是因为触发了安全限制或无法识别。如果擦除效果不理想，请尝试调整提示词，或上传更清晰的图片。
          </div>
          <details className="text-[10px] text-zinc-400 cursor-pointer hover:text-zinc-600 transition-colors">
            <summary className="font-medium">如何获得更好的擦除效果？</summary>
            <ul className="list-disc pl-4 mt-1 space-y-1">
              <li>描述要具体：例如“擦除所有红色笔迹”比“清除标记”更有效。</li>
              <li>分步处理：如果一张图有很多标记，可以先清除一种颜色，再清除另一种。</li>
              <li>光线充足：确保拍摄的照片光线均匀，没有严重的阴影或反光。</li>
              <li>对焦清晰：文字越清晰，AI 越容易区分打印字和手写字。</li>
            </ul>
          </details>
        </div>

        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 flex items-start gap-3">
            <div className="mt-0.5">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div>
              <h3 className="font-medium">处理失败</h3>
              <p className="text-sm mt-1 opacity-90">{error}</p>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Left Column: Upload & Source */}
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold flex items-center gap-2">
                <ImageIcon size={20} className="text-zinc-400" />
                原图 {sourcePages.length > 0 && `(${sourcePages.length}页)`}
              </h3>
              {sourcePages.length > 0 && (
                <button
                  onClick={clearImage}
                  className="text-sm text-zinc-500 hover:text-red-600 flex items-center gap-1 transition-colors"
                >
                  <Trash2 size={14} />
                  清空
                </button>
              )}
            </div>

            {!sourcePages.length ? (
              <div
                onClick={() => !isUploading && fileInputRef.current?.click()}
                className={`h-[500px] border-2 border-dashed rounded-2xl bg-white flex flex-col items-center justify-center gap-4 transition-all group ${
                  isUploading 
                    ? 'border-zinc-200 cursor-wait' 
                    : 'border-zinc-300 cursor-pointer hover:border-indigo-400 hover:bg-indigo-50/50'
                }`}
              >
                {isUploading ? (
                  <>
                    <div className="w-16 h-16 bg-indigo-50 rounded-full flex items-center justify-center">
                      <Loader2 size={28} className="text-indigo-600 animate-spin" />
                    </div>
                    <div className="text-center">
                      <p className="text-base font-medium text-zinc-700">正在处理文件...</p>
                      <p className="text-sm text-zinc-500 mt-1">PDF文件可能需要较长时间，请耐心等待</p>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="w-16 h-16 bg-zinc-100 group-hover:bg-indigo-100 rounded-full flex items-center justify-center transition-colors">
                      <Upload size={28} className="text-zinc-500 group-hover:text-indigo-600" />
                    </div>
                    <div className="text-center">
                      <p className="text-base font-medium text-zinc-700">点击上传试卷照片或PDF</p>
                      <p className="text-sm text-zinc-500 mt-1">支持 JPG, PNG, PDF 格式 (最大 100MB)</p>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="h-[500px] rounded-2xl overflow-y-auto bg-zinc-100 border border-zinc-200 shadow-sm p-4 flex flex-col gap-4">
                {sourcePages.map((page, idx) => (
                  <div key={idx} className="relative">
                    <div className="absolute top-2 left-2 bg-black/50 text-white text-xs px-2 py-1 rounded-md backdrop-blur-sm">
                      第 {idx + 1} 页
                    </div>
                    <img
                      src={page}
                      alt={`Source Page ${idx + 1}`}
                      className="w-full h-auto object-contain bg-white shadow-sm rounded-lg"
                    />
                  </div>
                ))}
              </div>
            )}

            <input
              type="file"
              ref={fileInputRef}
              onChange={handleImageUpload}
              accept="image/*,application/pdf"
              className="hidden"
            />

            <button
              onClick={processImage}
              disabled={sourcePages.length === 0 || isProcessing || !userPrompt.trim()}
              className={`w-full py-3.5 rounded-xl font-medium flex items-center justify-center gap-2 transition-all shadow-sm ${
                sourcePages.length === 0 || !userPrompt.trim()
                  ? 'bg-zinc-100 text-zinc-400 cursor-not-allowed'
                  : isProcessing
                  ? 'bg-indigo-100 text-indigo-700 cursor-wait'
                  : 'bg-indigo-600 text-white hover:bg-indigo-700 hover:shadow-md active:scale-[0.98]'
              }`}
            >
              {isProcessing ? (
                <>
                  <Loader2 size={20} className="animate-spin" />
                  AI 正在处理... ({resultPages.length}/{sourcePages.length})
                </>
              ) : (
                <>
                  <Sparkles size={20} />
                  {sourcePages.length === 0 ? '请先上传文件' : !userPrompt.trim() ? '请先输入清除需求' : '开始智能擦除'}
                </>
              )}
            </button>
          </div>

          {/* Right Column: Result */}
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold flex items-center gap-2">
                <Sparkles size={20} className="text-indigo-500" />
                处理结果 {resultPages.length > 0 && `(${resultPages.length}页)`}
              </h3>
              <div className="flex items-center gap-3">
                {resultPages.length > 0 && (
                  <div className="flex bg-zinc-100 p-1 rounded-lg">
                    <button
                      onClick={() => setViewMode('single')}
                      className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${
                        viewMode === 'single' ? 'bg-white text-indigo-600 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'
                      }`}
                    >
                      单页
                    </button>
                    <button
                      onClick={() => setViewMode('compare')}
                      className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${
                        viewMode === 'compare' ? 'bg-white text-indigo-600 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'
                      }`}
                    >
                      对比
                    </button>
                  </div>
                )}
                {resultPages.length > 0 && (
                  <button
                    onClick={downloadResult}
                    className="text-sm text-indigo-600 hover:text-indigo-700 font-medium flex items-center gap-1 transition-colors"
                  >
                    <Download size={16} />
                    下载保存
                  </button>
                )}
              </div>
            </div>

            <div className="h-[500px] rounded-2xl overflow-y-auto bg-white border border-zinc-200 shadow-sm relative flex flex-col items-center justify-center p-4">
              {resultPages.length > 0 ? (
                <div className="w-full flex flex-col gap-6">
                  {resultPages.map((page, idx) => (
                    <div key={idx} className="flex flex-col gap-2">
                      <div className="flex items-center justify-between px-1">
                        <span className="text-xs font-bold text-indigo-600 uppercase tracking-wider">第 {idx + 1} 页</span>
                        {viewMode === 'compare' && (
                          <div className="flex gap-4 text-[10px] font-medium text-zinc-400">
                            <span>左：原图</span>
                            <span>右：处理后</span>
                          </div>
                        )}
                      </div>
                      
                      {viewMode === 'compare' ? (
                        <div className="grid grid-cols-2 gap-2">
                          <div className="relative group">
                            <img
                              src={sourcePages[idx]}
                              alt={`Original Page ${idx + 1}`}
                              className="w-full h-auto object-contain bg-white shadow-sm rounded-lg border border-zinc-100"
                            />
                            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/5 transition-colors pointer-events-none rounded-lg"></div>
                          </div>
                          <div className="relative group">
                            <img
                              src={page}
                              alt={`Result Page ${idx + 1}`}
                              className="w-full h-auto object-contain bg-white shadow-sm rounded-lg border border-indigo-100 ring-2 ring-indigo-500/10"
                            />
                            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/5 transition-colors pointer-events-none rounded-lg"></div>
                          </div>
                        </div>
                      ) : (
                        <div className="relative">
                          <img
                            src={page}
                            alt={`Result Page ${idx + 1}`}
                            className="w-full h-auto object-contain bg-white shadow-sm rounded-lg border border-zinc-100"
                          />
                        </div>
                      )}
                    </div>
                  ))}
                  {isProcessing && resultPages.length < sourcePages.length && (
                    <div className="w-full py-8 flex flex-col items-center gap-3 text-zinc-500 bg-zinc-50 rounded-lg border border-zinc-100">
                      <Loader2 size={24} className="animate-spin text-indigo-500" />
                      <p className="text-sm">正在处理第 {resultPages.length + 1} 页...</p>
                    </div>
                  )}
                </div>
              ) : isProcessing ? (
                <div className="flex flex-col items-center gap-4 text-zinc-400">
                  <div className="relative">
                    <div className="w-16 h-16 border-4 border-zinc-100 rounded-full"></div>
                    <div className="w-16 h-16 border-4 border-indigo-500 rounded-full border-t-transparent animate-spin absolute top-0 left-0"></div>
                  </div>
                  <p className="text-sm font-medium animate-pulse">正在还原空白试卷...</p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3 text-zinc-400">
                  <ImageIcon size={48} className="opacity-20" />
                  <p className="text-sm">处理后的试卷将显示在这里</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
