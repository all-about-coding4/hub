from lynkio import Lynk, render_template

app = Lynk(port=8080, serve_client=True)

app.static("/static", "static")

@app.get("/")
async def home(req):
    return render_template("index.html")

if __name__ == "__main__":
    print("server running")
    app.run()