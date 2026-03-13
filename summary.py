import pyperclip
import os

README = "./README.md"
PLAN = "./进度.md"

MAIN = [
    "./render/main/",
    "./render/main/assets/",
    "./render/main/components/",
    "./render/main/locales/",
]

WINDOW = [
    "./render/window/",
    "./render/window/assets/",
    "./render/window/components/",
    "./render/window/utils/",
]

Copy_WINDOW = [
    "./Fast_window/",
]

PRELOAD = [
    "./preload/",
]

# 获取文件文本
def read_text(file_path,iscode = True):
    with open(file_path, 'r',encoding='utf-8') as file:
        if iscode:
            return f"```{file_path.split('.')[-1]}\n{file_path}\n"+file.read()+"\n```\n"
        else:
            return file.read()+"\n"


# 从置顶目录下获取文件文本
def get_text_from_dir(dir_path):
    text = ""
    for file in os.listdir(dir_path):
        file_path = os.path.join(dir_path, file)
        if os.path.isfile(file_path) and (file.endswith(".md") or file.endswith(".js") or file.endswith(".vue") or file.endswith(".json") or file.endswith(".html") or file.endswith(".css")):
            text += read_text(file_path)
    return text


def get_summary():
    readme = read_text(README,False)
    plan = read_text(PLAN,False)

    main_text = ""
    for file in MAIN:
        if os.path.isdir(file):
            main_text += get_text_from_dir(file)
        else:
            main_text += read_text(file)

    window_text = ""
    for file in WINDOW:
        if os.path.isdir(file):
            window_text += get_text_from_dir(file)
        else:
            window_text += read_text(file)
    
    preload = ""
    for file in PRELOAD:
        if os.path.isdir(file):
            preload += get_text_from_dir(file)
        else:
            preload += read_text(file)
    
    text = [
        "以下是AI Anywhere的README文件",
        readme,
        "以下是AI Anywhere的计划进度文件",
        plan,
        "以下是预加载文件和主页面,preload，preload.js是主界面的预加载文件、window_preload.js是独立窗口界面的预加载文件，其它是其他工具文件",
        preload,
        "以下是主页面的前端代码，在./Anywhere_main/目录下，是设置页面，其预加载文件为preload.js",
        main_text,
        "以下是独立窗口的前端代码，在./Anywhere_window/目录下，是独立窗口文件，其预加载文件为window_preload.js",
        window_text,
        # "以下是其他窗口的前端代码，在./Fast_window/目录下，是独立窗口文件，其预加载文件为fast_window_preload.js",
        # fast_window_text,
        "不论你进行如何修改，一定保证不会破坏已有的功能，前端修改一定要保持相同的主题风格，并保证节省开发者工作量的原则，请给出完整的函数代码并告诉我在哪里进行覆盖，直接告诉我在哪里进行怎样的修改就好了，不用给出全部文件代码，遇到不确定的内容，不要瞎猜，可以直接问我，我会提供相关文档\n\n"
    ]

    return "\n".join(text)

if __name__ == "__main__":
    sum = get_summary()
    with open("result.txt", "w", encoding='utf-8') as file:
        file.write(sum)
    # 将内容发送到剪切板
    pyperclip.copy(sum)
    print("内容已复制到剪切板")